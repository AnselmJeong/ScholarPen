import type { RevisionResponseSave } from '../../../shared/review-session/chapter-context';

export interface ResponseDraft {
  request: RevisionResponseSave; text: string; saved: string; saving: boolean; error: string;
}
/** Lives above the chapter views: changing chapters never discards an in-flight edit. */
export class ResponseDrafts {
  private entries = new Map<string, ResponseDraft>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private listeners = new Set<() => void>();
  private saving = new Map<string, Promise<void>>();
  private version = 0;
  constructor(private save: (request: RevisionResponseSave) => Promise<string>, private delay = 700) {}
  key = (path: string, id: string) => JSON.stringify([path, id]);
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.version;
  get = (key: string) => this.entries.get(key);
  private emit() { this.version++; this.listeners.forEach(fn => fn()); }
  change(request: RevisionResponseSave) {
    const key = this.key(request.projectPath, request.commentId);
    let draft = this.entries.get(key);
    if (!draft) { draft = { request, text: request.response, saved: request.expectedResponse, saving: false, error: '' }; this.entries.set(key, draft); }
    draft.text = request.response; draft.error = '';
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(() => { this.timers.delete(key); void this.flush(key); }, this.delay));
    this.emit();
  }
  flush(key: string): Promise<void> {
    clearTimeout(this.timers.get(key)); this.timers.delete(key);
    const active = this.saving.get(key);
    if (active) return active;
    const operation = this.saveLatest(key).finally(() => { this.saving.delete(key); });
    this.saving.set(key, operation);
    return operation;
  }
  private async saveLatest(key: string): Promise<void> {
    const draft = this.entries.get(key);
    if (!draft || draft.saving || draft.text === draft.saved) return;
    draft.saving = true; draft.error = ''; const submitted = draft.text; this.emit();
    try {
      draft.saved = await this.save({ ...draft.request, response: submitted, expectedResponse: draft.saved });
    } catch (error) { draft.error = String(error); }
    finally { draft.saving = false; this.emit(); }
    if (!draft.error && draft.text !== draft.saved) await this.saveLatest(key);
  }
  hasPending = () => [...this.entries.values()].some(d => d.saving || d.text !== d.saved);
  status = (): 'saved' | 'saving' | 'unsaved' => {
    if ([...this.entries.values()].some(d => d.error && d.text !== d.saved)) return 'unsaved';
    return this.hasPending() ? 'saving' : 'saved';
  };
  flushAll = () => Promise.all([...this.entries.keys()].map(key => this.flush(key)));
  async prepareReview(projectPath: string): Promise<void> {
    const relevant = [...this.entries].filter(([, draft]) => draft.request.projectPath === projectPath || draft.request.projectPath.startsWith(`${projectPath}/revisions/`));
    await Promise.all(relevant.map(([key]) => this.flush(key)));
    if (relevant.some(([, draft]) => draft.error || draft.saving || draft.text !== draft.saved)) throw new Error('답변을 저장하지 못했습니다. 입력 내용은 유지됩니다. 편집 화면에서 저장을 재시도한 뒤 답변서를 열거나 내보내 주세요.');
  }
}
