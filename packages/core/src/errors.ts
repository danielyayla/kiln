export class NotFoundError extends Error {
  constructor(id: string) {
    super(`Entity not found: ${id}`);
    this.name = "NotFoundError";
  }
}

export class ConstraintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConstraintError";
  }
}

// An edit operation could not be applied to a document body (missing or
// ambiguous anchor, invalid accepted-op index). Raised before any write, so
// the document is untouched when it surfaces.
export class EditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditError";
  }
}
