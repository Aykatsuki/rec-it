import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Copy, FolderOpen, FolderSearch, Pencil, Plus, Upload, X } from 'lucide-react';
import { Kbd } from '@rec-it/ui';
import { backend, shell } from '../api';
import { importWithDialog, openProjectWithDialog, saveProjectAs } from '../actions';
import { notify } from '../notifications';
import { useApp } from '../store';

export function ProjectMenu() {
  const project = useApp((s) => s.project);
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!project) return null;

  if (renaming) {
    return (
      <form
        className="project-rename"
        onSubmit={(e) => {
          e.preventDefault();
          const name = new FormData(e.currentTarget).get('name')?.toString().trim();
          setRenaming(false);
          if (name && name !== project.name) void backend.invoke('project.rename', { name });
        }}
      >
        <input
          name="name"
          className="ui-input"
          defaultValue={project.name}
          autoFocus
          maxLength={120}
          onBlur={(e) => e.currentTarget.form?.requestSubmit()}
          aria-label="Project name"
        />
      </form>
    );
  }

  const item = (label: string, icon: React.ReactNode, action: () => void, shortcut?: string) => (
    <button
      type="button"
      role="menuitem"
      className="menu__item"
      onClick={() => {
        setOpen(false);
        action();
      }}
    >
      {icon}
      <span>{label}</span>
      {shortcut && <Kbd>{shortcut}</Kbd>}
    </button>
  );

  return (
    <div className="menu" ref={ref}>
      <button
        type="button"
        className="topbar__project"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title={project.path}
      >
        {project.name}
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="menu__popover" role="menu">
          {item('Import media…', <Upload size={15} />, () => void importWithDialog(), 'Ctrl+I')}
          <div className="menu__sep" />
          {item(
            'New project',
            <Plus size={15} />,
            () => void backend.invoke('project.close', {}),
            'Ctrl+N',
          )}
          {item(
            'Open project…',
            <FolderOpen size={15} />,
            () => void openProjectWithDialog(),
            'Ctrl+O',
          )}
          {item('Save a copy as…', <Copy size={15} />, () => void saveProjectAs(), 'Ctrl+Shift+S')}
          {item('Rename project', <Pencil size={15} />, () => setRenaming(true))}
          {item(
            'Show project file',
            <FolderSearch size={15} />,
            () => void shell.invoke('shell.showItemInFolder', { path: project.path }),
          )}
          <div className="menu__sep" />
          {item(
            'Close project',
            <X size={15} />,
            () =>
              void backend
                .invoke('project.close', {})
                .then(() => notify('Project closed. Everything was already saved.')),
          )}
          <div className="menu__note">Changes are saved automatically.</div>
        </div>
      )}
    </div>
  );
}
