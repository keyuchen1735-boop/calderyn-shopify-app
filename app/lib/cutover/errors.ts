// Typed cutover-block error (Step 9). Thrown for merchant-correctable blocks —
// a failing go-live gate, an illegal mode move, a concurrent-change conflict — so
// the API layer can tell "the move is blocked, show the reason" (409) apart from a
// genuine system failure (500). Lives in its own module because org-mode.server.ts
// and go-live.server.ts both throw it and org-mode already imports go-live (a class
// in either would force a circular import).

export class CutoverBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CutoverBlockedError";
  }
}
