import { useState } from 'react';

/** A line of text to paste somewhere else, with a copy button. */
export function Copyable({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-block">
      <code className="mono">{text}</code>
      <button
        className="icon-btn"
        title="Copy"
        aria-label="Copy"
        onClick={() =>
          navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        <i className={'ph-duotone ' + (copied ? 'ph-check' : 'ph-copy')} />
      </button>
    </div>
  );
}

/** The line that lets Launchpad's key in, for when the server refused it. */
export const authorizeLine = (publicKey: string) => `mkdir -p -m 700 ~/.ssh && echo '${publicKey}' >> ~/.ssh/authorized_keys`;

/** Connection errors that mean the key isn't in authorized_keys yet. */
export const keyRefused = (error: string) => error.includes('authorized_keys');
