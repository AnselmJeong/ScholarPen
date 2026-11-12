/** Explicit legacy adapter. Canonical document reads remain available with UI disabled. */
import { BibliographyRepository, type BibliographyStorage } from "../../plugins/bibliography/main/repository";
const repositories = new WeakMap<object, BibliographyRepository>();
export function createBibliographyRepository(owner: object, storage: BibliographyStorage) {
  let repository = repositories.get(owner);
  if (!repository) { repository = new BibliographyRepository(storage); repositories.set(owner, repository); }
  return repository;
}
