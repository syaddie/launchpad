"""Server › Downloads' Instagram helper, run by server/src/instagram.ts.

It finds what Instagram posts are made of, with instaloader, and leaves the downloading
to Launchpad, which writes the files to the server over SSH like any other download. When
Instagram won't answer instaloader about a post, it reads the post's embed page instead.

One JSON request comes in on stdin (so the session cookie never shows in `ps`):

    {"cmd": "version"}
    {"cmd": "check", "session": {"sessionid": "…", "csrftoken": "…"}}
    {"cmd": "resolve", "posts": ["ABC123"], "profile": "natgeo", "limit": 12, "session": {…} | null}

and one JSON object a line goes out on stdout:

    {"type": "version", "instaloader": "4.16"}
    {"type": "me", "username": "you"}
    {"type": "post", "shortcode", "owner", "stem", "caption", "info", "items": [{"url", "ext"}]}
    {"type": "wait", "seconds": 120}           Instagram asked to slow down; carrying on after
    {"type": "skip", "target", "error", "code"} one post of several couldn't be read
    {"type": "session", "cookies": {…}}        the session's cookies after use, which Instagram renews
    {"type": "error", "error", "code"}         the whole request failed; the last line
    {"type": "done"}                           the last line otherwise
"""

import json
import re
import sys
import time
from datetime import datetime, timezone
from itertools import islice

try:
    import instaloader
    from instaloader import exceptions as ex
except ImportError:  # pragma: no cover - reported to the page as "not installed"
    instaloader = None

# Shortcodes are Instagram's base64 alphabet; usernames are letters, digits, dots and underscores.
SHORTCODE = re.compile(r"^[A-Za-z0-9_-]{5,64}$")
USERNAME = re.compile(r"^[A-Za-z0-9._]{1,30}$")
MAX_LIMIT = 500


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def ext_of(url, video):
    """The file extension, worked out the way instaloader does, so names match its own downloads."""
    m = re.search(r"\.([a-z0-9]*)\?", url)
    if m and m.group(1):
        return m.group(1)
    tail = url.split("?")[0].rsplit(".", 1)
    if len(tail) == 2 and re.fullmatch(r"[a-z0-9]{2,5}", tail[1]):
        return tail[1]
    return "mp4" if video else "jpg"


if instaloader is not None:

    class ReportingRateController(instaloader.RateController):
        """instaloader's own pacing, saying when it waits so the page can show it."""

        def sleep(self, secs):
            if secs > 5:
                emit({"type": "wait", "seconds": round(secs)})
            time.sleep(secs)


def make_loader():
    return instaloader.Instaloader(
        quiet=True,
        download_comments=False,
        download_geotags=False,
        save_metadata=False,
        compress_json=False,
        max_connection_attempts=3,
        request_timeout=30.0,
        rate_controller=lambda ctx: ReportingRateController(ctx),
    )


def clean_session(raw):
    """The cookies to send, as strings; at least a sessionid."""
    if not isinstance(raw, dict):
        return None
    cookies = {str(k): str(v) for k, v in raw.items() if isinstance(v, (str, int)) and str(v)}
    return cookies if cookies.get("sessionid") else None


def use_session(loader, cookies, username=None):
    """Sign the loader in with a browser's cookies. Returns the username they belong to, or None."""
    cookies = dict(cookies)
    if not cookies.get("csrftoken"):
        # instaloader needs a CSRF token alongside the session; Instagram's start page hands one out.
        resp = loader.context._session.get(
            "https://www.instagram.com/", cookies={"sessionid": cookies["sessionid"]}, timeout=30
        )
        cookies["csrftoken"] = resp.cookies.get("csrftoken") or loader.context._session.cookies.get("csrftoken") or ""
        if not cookies["csrftoken"]:
            raise ex.LoginException("Instagram didn’t hand out a CSRF token for that session.")
    loader.load_session(username or "", cookies)
    if username:
        return username
    who = loader.test_login()
    if who:
        loader.context.username = who
    return who


def describe(err):
    """A plain reason and a code the page can act on."""
    text = str(err).strip() or err.__class__.__name__
    low = text.lower()
    if isinstance(err, ex.PrivateProfileNotFollowedException):
        return "That account is private. Sign in as someone who follows it.", "private"
    if isinstance(err, ex.ProfileNotExistsException):
        return "There’s no Instagram account by that name.", "notfound"
    if isinstance(err, ex.LoginRequiredException) or "login_required" in low or "login required" in low:
        return "Instagram wants you signed in for that. Add your Instagram session in Downloads.", "login"
    if isinstance(err, ex.TooManyRequestsException) or "429" in low or "please wait a few minutes" in low:
        return "Instagram is limiting requests from the server. Wait a while, or sign in.", "limited"
    if isinstance(err, ex.QueryReturnedNotFoundException) or "not found" in low or "fetching post metadata failed" in low:
        return "Instagram couldn’t find that post. It may be deleted, private, or need you signed in.", "notfound"
    if "401" in low or "unauthorized" in low:
        return "Instagram refused the request without a login. Wait a while, or sign in.", "limited"
    if "403" in low or "forbidden" in low:
        return "Instagram refused the request (403). Sign in, or try again later.", "limited"
    if isinstance(err, ex.ConnectionException):
        return f"Couldn’t reach Instagram: {text}", "other"
    return text, "other"


class Failed(Exception):
    """A request that failed with a reason already worded for the page."""

    def __init__(self, msg, kind):
        super().__init__(msg)
        self.msg, self.kind = msg, kind


# ---------- the embed page, when Instagram won't answer instaloader ----------
#
# Instagram sometimes turns away the API calls instaloader makes from an IP it doesn't like (an
# empty answer, or 401 "Please wait a few minutes"), even for public posts. The page it serves
# for embedding a post on other sites still answers, and to anything that isn't a browser it
# carries the post's data in the page: every slide at full size, the caption and the owner.

EMBED_URL = "https://www.instagram.com/p/{}/embed/captioned/"
CONTEXT_KEY = '"contextJSON":'
# Instagram's media IDs start with when they were made, in milliseconds since this moment.
IG_EPOCH_MS = 1314220021721
MISSING = object()  # the embed page says there's no such post


def embed_media(html):
    """The post in an embed page: its shortcode_media, MISSING, or None when the page can't be read."""
    i = html.find(CONTEXT_KEY)
    if i < 0:
        return None
    try:
        raw, _ = json.JSONDecoder().raw_decode(html, i + len(CONTEXT_KEY))
        if raw is None:
            return MISSING
        media = ((json.loads(raw) or {}).get("gql_data") or {}).get("shortcode_media")
    except (ValueError, AttributeError, TypeError):
        return None
    return media if isinstance(media, dict) and media.get("shortcode") else MISSING


def media_date(media):
    """When it was posted: Instagram's own time when the page has it, otherwise read from the ID."""
    ts = media.get("taken_at_timestamp")
    if isinstance(ts, (int, float)) and ts > 0:
        return datetime.fromtimestamp(ts, timezone.utc)
    try:
        when = datetime.fromtimestamp(((int(media.get("id")) >> 23) + IG_EPOCH_MS) / 1000, timezone.utc)
    except (TypeError, ValueError, OverflowError, OSError):
        when = None
    now = datetime.now(timezone.utc)
    # IDs from before Instagram's current scheme don't hold a time; fall back to now.
    return when if when and datetime(2012, 1, 1, tzinfo=timezone.utc) < when <= now else now


def media_url(node):
    """A slide's file: the video if it is one, else the largest photo."""
    if node.get("is_video") and node.get("video_url"):
        return node["video_url"], True
    sizes = [r for r in node.get("display_resources") or [] if isinstance(r, dict) and r.get("src")]
    if sizes:
        return max(sizes, key=lambda r: r.get("config_width") or 0)["src"], False
    return node.get("display_url"), False


def count_of(media, *keys):
    for key in keys:
        n = (media.get(key) or {}).get("count")
        if isinstance(n, int):
            return n
    return None


def embed_event(media):
    """A post event, the same as post_event's, from an embed page's shortcode_media."""
    children = [e.get("node") or {} for e in (media.get("edge_sidecar_to_children") or {}).get("edges") or []]
    items = []
    for node in children or [media]:
        url, video = media_url(node)
        if url:
            items.append({"url": url, "ext": ext_of(url, video)})
    edges = (media.get("edge_media_to_caption") or {}).get("edges") or []
    caption = ((edges[0].get("node") or {}).get("text") or "") if edges else ""
    owner = (media.get("owner") or {}).get("username") or ""
    when = media_date(media)
    shortcode = media["shortcode"]
    return {
        "type": "post",
        "shortcode": shortcode,
        "owner": owner,
        "stem": when.strftime("%Y-%m-%d_%H-%M-%S") + "_UTC",
        "caption": caption,
        "info": {
            "shortcode": shortcode,
            "url": f"https://www.instagram.com/p/{shortcode}/",
            "owner": owner,
            "taken_at_utc": when.replace(tzinfo=None, microsecond=0).isoformat() + "Z",
            "caption": caption,
            "likes": count_of(media, "edge_liked_by", "edge_media_preview_like"),
            "comments": count_of(media, "edge_media_to_comment", "edge_media_preview_comment"),
            "type": media.get("__typename") or ("GraphSidecar" if children else "GraphImage"),
            "media": len(items),
            "via": "embed",
        },
        "items": items,
    }


def fetch_embed(code):
    """The post from its embed page: a post event, MISSING, or None when that didn't work either."""
    import requests  # comes with instaloader

    try:
        # A fresh session with requests' own User-Agent: to a browser's, Instagram sends a page
        # that builds itself in JavaScript instead, without the data.
        resp = requests.get(EMBED_URL.format(code), timeout=30, allow_redirects=True)
    except requests.RequestException:
        return None
    if resp.status_code == 404:
        return MISSING
    if resp.status_code != 200:
        return None
    media = embed_media(resp.text)
    if media is None or media is MISSING:
        return media
    event = embed_event(media)
    return event if event["items"] and event["owner"] else None


def fallback(code, err):
    """After instaloader failed on a post: the post from its embed page, or Failed saying why not."""
    msg, kind = describe(err)
    if kind in ("login", "private"):
        raise Failed(msg, kind)
    found = fetch_embed(code)
    if isinstance(found, dict):
        return found
    if found is MISSING or isinstance(err, ex.QueryReturnedNotFoundException):
        raise Failed("Instagram couldn’t find that post. It may be deleted, or on a private account.", "notfound")
    if kind == "notfound":
        # instaloader got an empty answer and the embed page didn't help: Instagram turning the
        # server away looks just like this, so don't call the post missing.
        raise Failed("Instagram wouldn’t show that post to the server. Try later, or sign in.", "limited")
    raise Failed(msg, kind)


def post_event(post):
    """What a post is made of: the photo or video of each slide, in order."""
    if post.typename == "GraphSidecar":
        nodes = list(post.get_sidecar_nodes())
        items = [
            {"url": n.video_url if n.is_video else n.display_url, "video": bool(n.is_video)}
            for n in nodes
            if (n.video_url if n.is_video else n.display_url)
        ]
    else:
        url = post.video_url if post.is_video else post.url
        items = [{"url": url, "video": bool(post.is_video)}] if url else []
    for it in items:
        it["ext"] = ext_of(it["url"], it.pop("video"))
    stem = post.date_utc.strftime("%Y-%m-%d_%H-%M-%S") + "_UTC"
    caption = post.caption or ""
    return {
        "type": "post",
        "shortcode": post.shortcode,
        "owner": post.owner_username,
        "stem": stem,
        "caption": caption,
        "info": {
            "shortcode": post.shortcode,
            "url": f"https://www.instagram.com/p/{post.shortcode}/",
            "owner": post.owner_username,
            "taken_at_utc": post.date_utc.isoformat() + "Z",
            "caption": caption,
            "likes": post.likes,
            "comments": post.comments,
            "type": post.typename,
            "media": len(items),
        },
        "items": items,
    }


def resolve(req):
    loader = make_loader()
    cookies = clean_session(req.get("session"))
    posts = [p for p in req.get("posts") or [] if isinstance(p, str)]
    profile = req.get("profile")
    limit = req.get("limit")
    limit = max(1, min(int(limit), MAX_LIMIT)) if isinstance(limit, (int, float)) else None

    if cookies:
        use_session(loader, cookies, req.get("username") or None)

    for code in posts:
        if not SHORTCODE.match(code):
            emit({"type": "skip", "target": code, "error": "That isn’t an Instagram post link.", "code": "other"})
            continue
        try:
            try:
                emit(post_event(instaloader.Post.from_shortcode(loader.context, code)))
            except ex.InstaloaderException as err:
                emit(fallback(code, err))
        except Failed as err:
            # One post is the whole request: say so as the error rather than a skip.
            if len(posts) == 1 and not profile:
                raise
            emit({"type": "skip", "target": code, "error": err.msg, "code": err.kind})

    if profile:
        if not isinstance(profile, str) or not USERNAME.match(profile):
            raise ex.InvalidArgumentException("That isn’t an Instagram username.")
        prof = instaloader.Profile.from_username(loader.context, profile)
        if prof.is_private and not prof.followed_by_viewer and loader.context.username != prof.username:
            raise ex.PrivateProfileNotFollowedException(f"{profile} is private")
        it = prof.get_posts()
        for post in islice(it, limit) if limit else it:
            emit(post_event(post))

    if cookies:
        emit({"type": "session", "cookies": loader.save_session()})


def main():
    try:
        req = json.loads(sys.stdin.buffer.read().decode("utf-8") or "{}")
    except ValueError:
        emit({"type": "error", "error": "The helper got a request it couldn’t read.", "code": "other"})
        return 2
    if instaloader is None:
        emit({"type": "error", "error": "instaloader isn’t installed for this Python.", "code": "missing"})
        return 3
    cmd = req.get("cmd")
    try:
        if cmd == "version":
            emit({"type": "version", "instaloader": instaloader.__version__})
        elif cmd == "check":
            cookies = clean_session(req.get("session"))
            if not cookies:
                emit({"type": "error", "error": "That doesn’t have a sessionid in it.", "code": "login"})
                return 1
            loader = make_loader()
            who = use_session(loader, cookies)
            if not who:
                emit({"type": "error", "error": "Instagram didn’t accept that session. Copy a fresh sessionid while signed in.", "code": "login"})
                return 1
            emit({"type": "me", "username": who})
            emit({"type": "session", "cookies": loader.save_session()})
        elif cmd == "resolve":
            resolve(req)
        else:
            emit({"type": "error", "error": f"Unknown command {cmd!r}.", "code": "other"})
            return 2
    except Failed as err:
        emit({"type": "error", "error": err.msg, "code": err.kind})
        return 1
    except ex.InstaloaderException as err:
        msg, kind = describe(err)
        emit({"type": "error", "error": msg, "code": kind})
        return 1
    except KeyboardInterrupt:
        return 130
    except Exception as err:  # noqa: BLE001 - anything else still ends with a line the page can show
        emit({"type": "error", "error": f"{err.__class__.__name__}: {err}", "code": "other"})
        return 1
    emit({"type": "done"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
