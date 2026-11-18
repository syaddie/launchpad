"""Server › Downloads' video helper, run by server/src/ytdlp.ts.

It downloads one video (or its sound) with yt-dlp into a folder of Launchpad's own, joins or
converts it with ffmpeg, and says where the file is; Launchpad then copies it to the server
over SSH like any other download, and deletes the folder.

One JSON request comes in on stdin:

    {"cmd": "version"}
    {"cmd": "check", "url": "https://vimeo.com/123"}
    {"cmd": "download", "url": "…", "format": "best" | "1080p" | "mp3", "dir": "/data/…", "ffmpeg": "" | path}

and one JSON object a line goes out on stdout:

    {"type": "version", "yt_dlp": "2026.10.26", "ffmpeg": true, "js": true}
    {"type": "check", "site": "Vimeo" | null}   null: yt-dlp has nothing better than fetching the link
    {"type": "info", "title", "site", "id", "playlist", "parts": [{"size": int | null}]}
                                                what is about to download: one part, or the video and its sound
    {"type": "progress", "part", "downloaded", "total", "speed", "eta"}
    {"type": "step", "step": "Merger" | "ExtractAudio" | …}   ffmpeg is working on it
    {"type": "file", "path"}                    the finished file
    {"type": "retry"}                           YouTube turned it away (403): starting again, once
    {"type": "error", "error", "code"}          the last line when it failed
    {"type": "done"}                            the last line otherwise
"""

import json
import os
import re
import shutil
import sys
import time

try:
    import yt_dlp
    from yt_dlp.postprocessor.common import PostProcessor
    from yt_dlp.utils import DownloadError
except ImportError:  # pragma: no cover - reported to the page as "not installed"
    yt_dlp = None
    PostProcessor = object
    DownloadError = Exception


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=True) + "\n")
    sys.stdout.flush()


class Stop(Exception):
    """A reason to stop that the page shows as it is, with a code for Launchpad."""

    def __init__(self, message, code):
        super().__init__(message)
        self.code = code


# What each choice on the page asks yt-dlp for.
FORMATS = {
    # yt-dlp's own default: the best video and the best sound, joined in whatever container suits them.
    "best": {"format": "bv*+ba/b"},
    # Up to 1080p (the nearest above when there's nothing at or under it), preferring H.264 and AAC
    # for the widest playback, always ending up an .mp4.
    "1080p": {
        "format": "bv*+ba/b",
        "format_sort": ["res:1080", "vcodec:h264", "ext:mp4:m4a"],
        "merge_output_format": "mp4",
        "postprocessors": [{"key": "FFmpegVideoRemuxer", "preferedformat": "mp4"}],
    },
    # The best sound, made an MP3 (left as it is when it's one already), with its title and artist.
    "mp3": {
        "format": "ba/b",
        "postprocessors": [
            {"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "0"},
            {"key": "FFmpegMetadata", "add_metadata": True},
        ],
    },
}


def clean_error(text):
    """yt-dlp's message without its "ERROR: [site] id:" start and its "please report this" end."""
    t = re.sub(r"\x1b\[[0-9;]*m", "", str(text)).strip()
    t = re.sub(r"^ERROR:\s*", "", t)
    t = re.sub(r"^\[[^\]]+\]\s*(?:[^:\s]+:\s*)?", "", t)
    t = re.split(r";\s*please report this issue", t, flags=re.I)[0]
    t = re.split(r"\s*\(caused by ", t)[0].strip().rstrip(".")
    return t[:1].upper() + t[1:] + "." if t else "yt-dlp stopped without saying why."


def error_code(text):
    t = str(text).lower()
    if "unsupported url" in t:
        return "unsupported"
    if "ffmpeg" in t and ("not found" in t or "not installed" in t):
        return "ffmpeg"
    if "no space left" in t:
        return "space"
    if "sign in" in t or "login" in t or "cookies" in t:
        return "login"
    return "other"


class AnnouncePP(PostProcessor):
    """Before the download: say what it is and how big, and refuse live streams."""

    def run(self, info):
        if info.get("is_live"):
            raise Stop("That’s a live stream. Download it once it has finished.", "live")
        parts = info.get("requested_formats") or [info]
        emit(
            {
                "type": "info",
                "title": info.get("title") or info.get("id") or "",
                "site": info.get("extractor_key") or info.get("extractor") or None,
                "id": info.get("id") or "",
                "playlist": bool(info.get("playlist_id") or info.get("playlist")),
                "parts": [{"size": f.get("filesize") or f.get("filesize_approx") or None} for f in parts],
            }
        )
        return [], info


class FinishedPP(PostProcessor):
    """After the file has its final name: say where it is."""

    def run(self, info):
        path = info.get("filepath") or info.get("_filename")
        if path:
            emit({"type": "file", "path": os.path.abspath(path)})
        return [], info


def download(req):
    choice = FORMATS.get(req.get("format")) or FORMATS["best"]
    folder = req["dir"]
    state = {"part": 0, "last": None, "at": 0.0, "step": None}

    def on_progress(d):
        status = d.get("status")
        if status not in ("downloading", "finished"):
            return
        # A new part (the sound after the video) comes with a new format.
        fid = (d.get("info_dict") or {}).get("format_id")
        changed = state["last"] is not None and fid != state["last"]
        if changed:
            state["part"] += 1
        state["last"] = fid
        now = time.monotonic()
        if status == "downloading" and not changed and now - state["at"] < 0.5:
            return
        state["at"] = now
        done = d.get("downloaded_bytes") or 0
        total = d.get("total_bytes") or d.get("total_bytes_estimate") or None
        if status == "finished":
            done = done or total or 0
            total = total or done or None
        emit({"type": "progress", "part": state["part"], "downloaded": done, "total": total, "speed": 0 if status == "finished" else d.get("speed") or 0, "eta": 0 if status == "finished" else d.get("eta")})

    def on_step(d):
        name = d.get("postprocessor") or ""
        if d.get("status") == "started" and name not in ("MoveFiles", "Announce", "Finished") and name != state["step"]:
            state["step"] = name
            emit({"type": "step", "step": name})

    class Quiet:
        """yt-dlp's messages go to stderr, where Launchpad keeps the last few for when it stops."""

        def debug(self, msg):
            pass

        def info(self, msg):
            pass

        def warning(self, msg):
            sys.stderr.write(f"{msg}\n")

        def error(self, msg):
            sys.stderr.write(f"{msg}\n")

    opts = {
        "paths": {"home": folder, "temp": folder},
        "outtmpl": {"default": "%(title).150B [%(id)s].%(ext)s"},
        # One video: a link into a playlist gets that video, and a playlist's link its first.
        "noplaylist": True,
        "playlist_items": "1",
        "overwrites": True,
        "continuedl": False,
        "noprogress": True,
        "quiet": True,
        "no_color": True,
        "logger": Quiet(),
        "retries": 5,
        "fragment_retries": 5,
        "socket_timeout": 30,
        "progress_hooks": [on_progress],
        "postprocessor_hooks": [on_step],
        # YouTube's player needs JavaScript worked out: the Node.js that Launchpad runs on does it.
        "js_runtimes": {"node": {"path": req["node"]} if req.get("node") else {}},
        **{k: v for k, v in choice.items() if k != "postprocessors"},
        "postprocessors": list(choice.get("postprocessors", [])),
    }
    if req.get("ffmpeg"):
        opts["ffmpeg_location"] = req["ffmpeg"]
    # YouTube now and then turns a download's address away (HTTP 403). A fresh look at the video
    # usually gets one that works, so that's tried once before giving up.
    for attempt in range(2):
        state.update(part=0, last=None, at=0.0, step=None)
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                ydl.add_post_processor(AnnouncePP(ydl), when="before_dl")
                ydl.add_post_processor(FinishedPP(ydl), when="after_move")
                ydl.download([req["url"]])
            return
        except DownloadError as e:
            if attempt or "HTTP Error 403" not in str(e):
                raise
            emit({"type": "retry"})


def check(url):
    """Which site yt-dlp knows the link as, without fetching anything; None for its catch-all."""
    for ie in yt_dlp.extractor.gen_extractor_classes():
        if ie.suitable(url):
            if ie.ie_key() == "Generic" or not ie.working():
                return None
            # "vimeo", "twitch:vod", "BBC": the site's part, capitalised when yt-dlp didn't.
            name = str(ie.IE_NAME).split(":")[0]
            return name[:1].upper() + name[1:] if name.islower() else name
    return None


def main():
    if yt_dlp is None:
        emit({"type": "error", "error": "yt-dlp isn’t installed.", "code": "missing"})
        return
    try:
        req = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        emit({"type": "error", "error": "Launchpad sent the helper something it couldn’t read.", "code": "other"})
        return
    cmd = req.get("cmd")
    try:
        if cmd == "version":
            emit({"type": "version", "yt_dlp": yt_dlp.version.__version__, "ffmpeg": bool(req.get("ffmpeg") or shutil.which("ffmpeg")), "js": bool(shutil.which("node"))})
        elif cmd == "check":
            emit({"type": "check", "site": check(str(req.get("url") or ""))})
        elif cmd == "download":
            download(req)
        else:
            raise Stop("Launchpad asked the helper for something it doesn’t do.", "other")
    except Stop as e:
        emit({"type": "error", "error": str(e), "code": e.code})
        return
    except DownloadError as e:
        inner = getattr(e, "exc_info", None)
        if inner and isinstance(inner[1], Stop):
            emit({"type": "error", "error": str(inner[1]), "code": inner[1].code})
        else:
            emit({"type": "error", "error": clean_error(e.msg if hasattr(e, "msg") else e), "code": error_code(e)})
        return
    except Exception as e:  # noqa: BLE001 - anything else is shown as it is
        emit({"type": "error", "error": clean_error(e), "code": error_code(e)})
        return
    emit({"type": "done"})


if __name__ == "__main__":
    main()
