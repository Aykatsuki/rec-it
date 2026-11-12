import { useState } from 'react';
import { create } from 'zustand';
import { ShieldCheck, X } from 'lucide-react';
import type { RightsInput, RightsSource } from '@rec-it/ipc-contract';
import { Button, Dialog, TextField } from '@rec-it/ui';
import { RIGHTS_LABELS } from '../format';

interface Request {
  id: number;
  count: number;
  editing: boolean;
  initial: RightsInput;
  resolve: (rights: RightsInput | null) => void;
}
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));
let nextRequest = 1;

const LAST_KEY = 'recit.lastRights';
function lastChoice(): RightsInput {
  try {
    const stored = JSON.parse(localStorage.getItem(LAST_KEY) ?? 'null') as RightsInput | null;
    if (stored?.source) return { ...stored, userAttested: false };
  } catch {
    // ignore
  }
  return { source: 'own-recording', userAttested: false };
}

/** Asks where the files came from (ADR-012). Resolves null if the user cancels. */
export function requestRights(count: number, current?: RightsInput): Promise<RightsInput | null> {
  return new Promise((resolve) => {
    useRequest.setState({
      request: {
        id: nextRequest++,
        count,
        editing: !!current,
        initial: current ?? lastChoice(),
        resolve,
      },
    });
  });
}

const HELP: Record<RightsSource, string> = {
  'own-recording': 'Footage you filmed or recorded yourself.',
  'own-youtube-upload': 'Your own video, downloaded from YouTube Studio.',
  'creative-commons':
    'Shared under a Creative Commons licence. Rec-It will write the credit for you.',
  'licensed-stock': 'Bought or licensed from a stock library.',
  'licensed-other': 'You have permission from the owner.',
  unknown: 'Rec-It will remind you to check before export.',
};

export function RightsDialogHost() {
  const request = useRequest((s) => s.request);
  if (!request) return null;
  return <RightsForm key={request.id} request={request} />;
}

function RightsForm({ request }: { request: Request }) {
  const [rights, setRights] = useState<RightsInput>(request.initial);
  const close = (result: RightsInput | null) => {
    useRequest.setState({ request: null });
    request.resolve(result);
  };
  const needsAttest = rights.source !== 'unknown';
  const urlInvalid = !!rights.originUrl && !/^https?:\/\//.test(rights.originUrl);
  const canSubmit = (!needsAttest || rights.userAttested) && !urlInvalid;

  const submit = () => {
    const clean: RightsInput = {
      source: rights.source,
      userAttested: needsAttest && rights.userAttested,
      ...(rights.source === 'creative-commons'
        ? {
            ...(rights.licence ? { licence: rights.licence } : {}),
            ...(rights.author ? { author: rights.author } : {}),
            ...(rights.originUrl ? { originUrl: rights.originUrl } : {}),
          }
        : {}),
    };
    try {
      localStorage.setItem(LAST_KEY, JSON.stringify(clean));
    } catch {
      // ignore
    }
    close(clean);
  };

  return (
    <Dialog
      open
      onClose={() => close(null)}
      title={
        request.count === 1 ? 'Where is this from?' : `Where are these ${request.count} files from?`
      }
      closeIcon={<X size={16} />}
    >
      <form
        className="rights"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) submit();
        }}
      >
        <fieldset className="rights__options">
          <legend className="sr-only">Source</legend>
          {(Object.keys(RIGHTS_LABELS) as RightsSource[]).map((source) => (
            <label key={source} className="rights__option" data-checked={rights.source === source}>
              <input
                type="radio"
                name="source"
                value={source}
                checked={rights.source === source}
                onChange={() => setRights({ ...rights, source })}
              />
              <span>
                <strong>{RIGHTS_LABELS[source]}</strong>
                <small>{HELP[source]}</small>
              </span>
            </label>
          ))}
        </fieldset>

        {rights.source === 'creative-commons' && (
          <div className="rights__cc">
            <TextField
              placeholder="Licence, e.g. CC BY 4.0"
              value={rights.licence ?? ''}
              onChange={(e) => setRights({ ...rights, licence: e.target.value })}
              aria-label="Licence"
            />
            <TextField
              placeholder="Creator name"
              value={rights.author ?? ''}
              onChange={(e) => setRights({ ...rights, author: e.target.value })}
              aria-label="Creator"
            />
            <TextField
              placeholder="Original link (https://…)"
              value={rights.originUrl ?? ''}
              onChange={(e) => setRights({ ...rights, originUrl: e.target.value })}
              aria-label="Original link"
            />
          </div>
        )}

        {needsAttest && (
          <label className="rights__attest">
            <input
              type="checkbox"
              checked={rights.userAttested}
              onChange={(e) => setRights({ ...rights, userAttested: e.target.checked })}
            />
            <ShieldCheck size={16} />I have the right to use{' '}
            {request.count === 1 ? 'this file' : 'these files'} in my videos.
          </label>
        )}
        <p className="rights__note">This is a record for you, not legal advice.</p>

        <div className="dialog-actions">
          <Button variant="ghost" onClick={() => close(null)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!canSubmit}>
            {request.editing
              ? 'Save'
              : request.count === 1
                ? 'Import'
                : `Import ${request.count} files`}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
