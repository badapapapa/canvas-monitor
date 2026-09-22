/**
 * The mirror's confinement guard (DECISIONS.md D-58).
 *
 * The mirror copies new archive files into my own NUS folders. It may write
 * ONLY inside   <destinationRoot>/<term folder>/<module folder>/<subfolder>/
 * for a term and module in the mapping (subfolder: "Downloaded from Canvas"),
 * and it may never write anywhere under the archive. Every path the mirror
 * writes, creates or renames passes `writable()` first; every path it reads
 * passes `readable()`. Anything else throws before the filesystem is touched.
 *
 * Paths are checked through symlinks: the deepest existing ancestor is
 * resolved with realpath, so a symlink planted inside an allowed folder cannot
 * carry a write outside it.
 */

import { realpathSync, existsSync } from 'node:fs';
import path from 'node:path';
import { safeSegment } from '../archive/filename.ts';

export class MirrorGuardError extends Error {
  constructor(message: string) {
    super(`Mirror guard refused: ${message}`);
    this.name = 'MirrorGuardError';
  }
}

export interface MirrorRoots {
  archiveRoot: string;
  destinationRoot: string;
  subfolder: string;
  /** archive term folder -> my term folder, e.g. "2610" -> "y2s1". */
  terms: Record<string, string>;
  /** module code -> my module folder. */
  modules: Record<string, string>;
}

/** Resolve through symlinks as far as the path exists; the rest is lexical. */
function resolveReal(p: string): string {
  let existing = path.resolve(p);
  const tail: string[] = [];
  while (!existsSync(existing)) {
    tail.unshift(path.basename(existing));
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  return path.join(realpathSync(existing), ...tail);
}

function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export class MirrorGuard {
  private readonly roots: MirrorRoots;
  private readonly archiveReal: string;
  private readonly allowed: Map<string, string>;

  constructor(roots: MirrorRoots) {
    this.roots = roots;
    if (safeSegment(roots.subfolder) !== roots.subfolder || roots.subfolder === '') throw new MirrorGuardError(`subfolder "${roots.subfolder}" is not a single safe name`);
    this.archiveReal = resolveReal(roots.archiveRoot);
    const destReal = resolveReal(roots.destinationRoot);
    if (inside(destReal, this.archiveReal) || inside(this.archiveReal, destReal) || destReal === this.archiveReal) {
      throw new MirrorGuardError('the destination and the archive overlap');
    }
    this.allowed = new Map();
    for (const [term, termFolder] of Object.entries(roots.terms)) {
      for (const [module, moduleFolder] of Object.entries(roots.modules)) {
        for (const seg of [termFolder, moduleFolder]) {
          if (safeSegment(seg) !== seg) throw new MirrorGuardError(`mapped folder "${seg}" is not a single safe name`);
        }
        this.allowed.set(`${term}/${module}`, path.join(destReal, termFolder, moduleFolder, roots.subfolder));
      }
    }
  }

  /** The one folder the mirror may write into for this archive term and module, or null if unmapped. */
  subtreeFor(term: string, module: string): string | null {
    return this.allowed.get(`${term}/${module}`) ?? null;
  }

  /** Throws unless `target` is strictly inside some allowed subtree and not under the archive. */
  writable(target: string): string {
    const lexical = path.resolve(target);
    if (path.basename(lexical) === '.DS_Store') throw new MirrorGuardError('.DS_Store is never written');
    const real = resolveReal(lexical);
    if (real === this.archiveReal || inside(real, this.archiveReal)) throw new MirrorGuardError(`a write under the archive (${target})`);
    for (const subtree of this.allowed.values()) {
      // `real` is resolved through every existing symlink (path.resolve has
      // already removed any `..`), so this is the comparison that matters.
      if (inside(real, subtree)) return lexical;
    }
    throw new MirrorGuardError(`a write outside every "${this.roots.subfolder}" folder (${target})`);
  }

  /** Throws unless `source` is inside the archive. */
  readable(source: string): string {
    const real = resolveReal(source);
    if (!inside(real, this.archiveReal)) throw new MirrorGuardError(`a read outside the archive (${source})`);
    return real;
  }
}
