class EmptyIssuesManager {
  static #instance = new EmptyIssuesManager();
  static instance(): EmptyIssuesManager { return EmptyIssuesManager.#instance; }
  addEventListener(): void {}
  removeEventListener(): void {}
  issues(): unknown[] { return []; }
}
export const Issue = Object.freeze({});
export const IssuesManager = Object.freeze({
  IssuesManager: EmptyIssuesManager,
  Events: Object.freeze({ISSUE_ADDED: 'IssueAdded', ISSUE_HIDDEN_STATUS_UPDATED: 'IssueHiddenStatusUpdated'}),
});
