import { create } from 'zustand';
import { X } from 'lucide-react';

type Tone = 'info' | 'warn' | 'error';
interface Toast {
  id: number;
  message: string;
  tone: Tone;
}
const useToasts = create<{ toasts: Toast[] }>(() => ({ toasts: [] }));
let next = 1;

export function notify(message: string, tone: Tone = 'info'): void {
  const id = next++;
  useToasts.setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, message, tone }] }));
  setTimeout(() => dismiss(id), tone === 'error' ? 9000 : 5000);
}

function dismiss(id: number) {
  useToasts.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast" data-tone={t.tone}>
          <span>{t.message}</span>
          <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
