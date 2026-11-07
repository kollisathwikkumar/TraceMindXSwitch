import { useEffect, useState } from 'react';
import type { BrainChange } from '@main/core/tracemind/brain/store';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { Textarea } from '@renderer/lib/ui/textarea';

/** Key this panel by location ID: drafts and retrieval results never follow a project switch. */
export function BrainProjectPanel({ locationId }: { locationId: string }) {
  const [enabled, setEnabled] = useState(false);
  const [bridgeEnabled, setBridgeEnabled] = useState(false);
  const [shareNotes, setShareNotes] = useState(false);
  const [paths, setPaths] = useState('');
  const [changes, setChanges] = useState<BrainChange[]>([]);
  const [task, setTask] = useState('');
  const [context, setContext] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    let active = true;
    void rpc.tracemind.getBrainSettings(locationId).then(
      ({ policy, changes }) => {
        if (!active) return;
        setEnabled(policy?.enabled ?? false);
        setBridgeEnabled(policy?.bridgeEnabled ?? false);
        setShareNotes(policy?.shareNotes ?? false);
        setPaths(policy?.allowedPaths.join('\n') ?? '');
        setChanges(changes);
        setBusy(false);
      },
      () => {
        if (active) {
          setMessage('Project brain settings could not be loaded.');
          setBusy(false);
        }
      }
    );
    return () => {
      active = false;
    };
  }, [locationId]);
  async function save() {
    setBusy(true);
    setMessage('');
    try {
      const policy = await rpc.tracemind.configureBrainProject(locationId, {
        enabled,
        bridgeEnabled,
        shareNotes,
        allowedPaths: [
          ...new Set(
            paths
              .split('\n')
              .map((path) => path.trim())
              .filter(Boolean)
          ),
        ],
      });
      setMessage(
        policy
          ? 'Project brain policy saved. Restart already-running agent sessions after installing this build.'
          : 'Project approval was cancelled.'
      );
      setContext('');
    } catch {
      setMessage(
        'Project policy was not saved. Check the provider, exact relative paths, and native approval.'
      );
    } finally {
      setBusy(false);
    }
  }
  async function preview() {
    setBusy(true);
    setContext('');
    try {
      setContext(JSON.stringify(await rpc.tracemind.getBrainContext(locationId, task), null, 2));
    } catch {
      setMessage('Local context retrieval failed. Check the project index and policy.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      aria-label="Project brain isolation"
      className="mt-4 flex flex-col gap-3 rounded-lg border border-border p-4"
    >
      <h3 className="font-medium">Project isolation & context</h3>
      <p className="text-sm text-foreground-muted">
        One provider powers task routing, investigations, and runtime advisories. Each project has
        its own sharing policy. TraceMind does not attach source-file contents to model requests.
        Task text and selected metadata leave the device only after project approval; optional notes
        use best-effort credential redaction.
      </p>
      <label>
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={(event) => setEnabled(event.target.checked)}
        />{' '}
        Allow this project to use the brain model
      </label>
      <label>
        <input
          type="checkbox"
          checked={bridgeEnabled}
          disabled={busy}
          onChange={(event) => setBridgeEnabled(event.target.checked)}
        />{' '}
        Connect this project to local Switch agent sessions
      </label>
      <label>
        <input
          type="checkbox"
          checked={shareNotes}
          disabled={busy}
          onChange={(event) => setShareNotes(event.target.checked)}
        />{' '}
        Also share selected notes and incident summaries with the model
      </label>
      <label className="flex flex-col gap-2">
        Approved relative file paths (one exact path per line; no wildcards)
        <Textarea
          aria-label="Brain approved paths"
          value={paths}
          maxLength={20000}
          disabled={busy}
          onChange={(event) => setPaths(event.target.value)}
        />
      </label>
      <p className="text-xs text-foreground-muted">
        The agent bridge receives only matching indexed paths and redacted graph notes. Its coding
        provider remains separate; these context instructions are not an operating-system
        file-access sandbox.
      </p>
      <Button type="button" disabled={busy} onClick={() => void save()}>
        Save project brain policy
      </Button>
      <label className="flex flex-col gap-2">
        Task to preview locally
        <Textarea
          value={task}
          maxLength={8000}
          disabled={busy}
          onChange={(event) => setTask(event.target.value)}
        />
      </label>
      <Button
        type="button"
        variant="outline"
        disabled={busy || !task.trim()}
        onClick={() => void preview()}
      >
        Preview local context (no model call)
      </Button>
      {message && <p role="status">{message}</p>}
      {context && (
        <pre className="max-h-80 overflow-auto text-xs whitespace-pre-wrap">{context}</pre>
      )}
      <details>
        <summary>Local change journal ({changes.length} retained records)</summary>
        <pre className="max-h-80 overflow-auto text-xs whitespace-pre-wrap">
          {JSON.stringify(changes.slice(-20), null, 2)}
        </pre>
      </details>
    </section>
  );
}
