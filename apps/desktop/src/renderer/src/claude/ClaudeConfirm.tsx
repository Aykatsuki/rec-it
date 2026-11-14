import { Sparkles } from 'lucide-react';
import { Button, Dialog } from '@rec-it/ui';
import { backend } from '../api';
import { notify } from '../notifications';
import { setOnClaudeConnected, useApp } from '../store';

const respond = (id: string, allow: boolean) =>
  void backend.invoke('claude.respond', { id, allow }).catch(() => {});

/** Asks before Claude starts an export or a transcription (ADR-044). */
export function ClaudeConfirmHost() {
  const confirmation = useApp((s) => s.claude?.confirmations[0]);
  return (
    <Dialog
      open={!!confirmation}
      title="Claude is asking"
      onClose={() => confirmation && respond(confirmation.id, false)}
      closeLabel="Decline"
    >
      {confirmation && (
        <div className="claude-confirm" data-testid="claude-confirm">
          <p className="claude-confirm__title">
            <Sparkles size={15} /> {confirmation.title}
          </p>
          <p>{confirmation.detail}</p>
          <div className="claude__actions">
            <Button onClick={() => respond(confirmation.id, false)}>Decline</Button>
            <Button variant="primary" onClick={() => respond(confirmation.id, true)}>
              Allow
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

setOnClaudeConnected((state) => {
  const name = state.clients.at(-1)?.name ?? 'Claude';
  notify(`${name} connected. It can now read and edit this project; see the Claude tab.`);
});
