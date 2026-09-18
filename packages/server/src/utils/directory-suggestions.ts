import type { Dirent, Stats } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { scorePathMatch, type MatchScore } from "@getpaseo/protocol/search/text-match";
import { isPathInsideRoot } from "./path.js";
import { runGitCommand } from "./run-git-command.js";

export type DirectorySuggestionKind = "file" | "directory";
export type DirectorySuggestionPathFormat = "absolute" | "relative";
export type DirectorySuggestionMatchMode = "fuzzy" | "suffix";
export type PathQueryPolicy = "rooted" | "slashes";
export type BlankQueryBehavior = "none" | "children";

export interface DirectorySuggestionEntry {
  path: string;
  kind: DirectorySuggestionKind;
}

export interface SearchDirectoryEntriesOptions {
  root: string;
  query: string;
  pathFormat: DirectorySuggestionPathFormat;
  includeFiles?: boolean;
  includeDirectories?: boolean;
  matchMode?: DirectorySuggestionMatchMode;
  pathQueryPolicy?: PathQueryPolicy;
  rootAliases?: string[];
  blankQueryBehavior?: BlankQueryBehavior;
  traversableHiddenDirectoryNames?: readonly string[];
  limit?: number;
  maxDepth?: number;
  maxEntriesScanned?: number;
  /** Scan cap for browse queries (empty query, or a query naming a directory). */
  browseMaxEntriesScanned?: number;
  /** Cap on children materialized from one directory listing, applied before sorting. */
  maxChildrenPerDirectory?: number;
  /** Wall-clock budget for a single scan. 0 disables the deadline. */
  deadlineMs?: number;
  /** Absolute deadline on the Date.now() timeline. Takes precedence over deadlineMs. */
  deadlineAt?: number;
  confidentResultScanThreshold?: number;
  respectGitIgnore?: boolean;
}

interface QueryPlan {
  isPathQuery: boolean;
  parentPart: string;
  searchTerm: string;
  normalizedQuery: string;
  browseExactPath?: boolean;
}

interface ChildEntry {
  name: string;
  resolvedPath: string;
  kind: DirectorySuggestionKind;
}

interface RawChildEntry {
  name: string;
  kind: DirectorySuggestionKind | "symlink";
}

interface TraversedEntry extends ChildEntry {
  visiblePath: string;
  depth: number;
}

interface RankedEntry extends DirectorySuggestionEntry {
  matchTier: number;
  segmentIndex: number;
  matchOffset: number;
  fuzzyScore: number;
  depth: number;
}

interface RankFields {
  matchTier: number;
  segmentIndex: number;
  matchOffset: number;
  fuzzyScore: number;
}

interface DirectoryListCacheEntry {
  expiresAt: number;
  modifiedAtMs: number;
  changedAtMs: number;
  entries: RawChildEntry[];
}

interface GitIgnoredPathsCacheEntry {
  expiresAt: number;
  paths: Promise<Set<string>>;
}

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_MAX_ENTRIES_SCANNED = 20_000;
const DIRECTORY_LIST_CACHE_TTL_MS = 8_000;
const DIRECTORY_LIST_CACHE_MAX_ENTRIES = 4_000;
// A listing of a six-figure-child directory is tens of megabytes and every scan can only
// consume its scan budget, so cap both what is materialized and what is retained.
const DIRECTORY_LIST_CACHE_MAX_CHILDREN = 5_000;
const DEFAULT_MAX_CHILDREN_PER_DIRECTORY = 20_000;
const GIT_IGNORED_PATHS_CACHE_TTL_MS = 8_000;
const GIT_IGNORED_PATHS_CACHE_MAX_ENTRIES = 256;
// A browse query (empty query, or a query naming a directory) used to list every child of
// the target directory; bound it the way the tree search is bounded.
const DEFAULT_BROWSE_MAX_ENTRIES_SCANNED = 4_000;
// One scan may not run longer than this. A legitimate fuzzy search from a large home root
// spends roughly 9s scanning its 20k-entry budget, so keep headroom above that while still
// cutting the multi-minute tail seen in production.
const DEFAULT_SEARCH_DEADLINE_MS = 15_000;
// Suggestion scans are client-driven and used to run in unbounded numbers: sixteen were
// observed in flight at once on a single connection.
const MAX_CONCURRENT_SEARCHES = 2;
// Windows does not reliably update directory mtime/ctime when children change,
// so metadata cannot safely validate a cross-request listing cache there.
const CAN_VALIDATE_DIRECTORY_CACHE_FROM_METADATA = process.platform !== "win32";
const MAX_CONFIDENT_FUZZY_SKIPS_PER_CHARACTER = 2;
const NO_SEGMENT_INDEX = Number.MAX_SAFE_INTEGER;
const NO_MATCH_OFFSET = Number.MAX_SAFE_INTEGER;
const NO_FUZZY_SCORE = Number.MAX_SAFE_INTEGER;
const NO_MATCH_TIER = 5;
export const WORKSPACE_SEARCH_HIDDEN_DIRECTORIES = [
  ".agents",
  ".claude",
  ".codex",
  ".github",
  ".opencode",
  ".paseo",
  ".vscode",
] as const;
const IGNORED_DIRECTORY_NAMES = new Set([
  "node_modules",
  "venv",
  "env",
  "virtualenv",
  "dist",
  "build",
  "target",
  "out",
  "coverage",
  "vendor",
  "__pycache__",
  ".git",
]);
const directoryListCache = new Map<string, DirectoryListCacheEntry>();
const gitIgnoredPathsCache = new Map<string, GitIgnoredPathsCacheEntry>();
const searchGate: { active: number; waiters: Array<() => void> } = { active: 0, waiters: [] };
const inFlightSearches = new Map<string, Promise<DirectorySuggestionEntry[]>>();

// Discovery and retrieval filter differently, on purpose. Discovery — anything that ranks or
// browses candidates the caller has not named — drops gitignored and hidden entries, so pickers
// do not offer build output. Retrieval of a path the caller named exactly applies no ignore or
// hidden filtering; the only question is whether the path stays inside the root. Clicking a file
// reference an agent wrote must open it whether or not Git tracks it.
export async function searchDirectoryEntries(
  options: SearchDirectoryEntriesOptions,
): Promise<DirectorySuggestionEntry[]> {
  const key = buildSearchKey(options);
  const inFlight = inFlightSearches.get(key);
  if (inFlight) return inFlight;

  const run = (async () => {
    await acquireSearchSlot();
    try {
      return await runSearchDirectoryEntries(options);
    } finally {
      releaseSearchSlot();
    }
  })();

  inFlightSearches.set(key, run);
  try {
    return await run;
  } finally {
    inFlightSearches.delete(key);
  }
}

function acquireSearchSlot(): Promise<void> {
  if (searchGate.active < MAX_CONCURRENT_SEARCHES) {
    searchGate.active += 1;
    return Promise.resolve();
  }
  // The slot is handed straight to the waiter, so a caller that arrives while the queue drains
  // cannot jump ahead of it.
  return new Promise<void>((resolve) => {
    searchGate.waiters.push(() => {
      searchGate.active += 1;
      resolve();
    });
  });
}

function releaseSearchSlot(): void {
  searchGate.active = Math.max(0, searchGate.active - 1);
  const next = searchGate.waiters.shift();
  if (next) next();
}

function resolveDeadlineAt(deadlineMs: number | undefined): number {
  if (deadlineMs === 0) return Number.POSITIVE_INFINITY;
  const windowMs =
    typeof deadlineMs === "number" && Number.isFinite(deadlineMs) && deadlineMs > 0
      ? deadlineMs
      : DEFAULT_SEARCH_DEADLINE_MS;
  return Date.now() + windowMs;
}

function isPastDeadline(input: SearchInput): boolean {
  return Date.now() >= input.deadlineAt;
}

// Concurrent requests for identical input share one scan, so a client that re-asks while a
// slow search is in flight cannot multiply the work. Every option that changes what the scan
// reads or how it formats results belongs in the key; only the absolute deadline is left out,
// because joiners inherit the deadline of the run they join rather than extending it.
function buildSearchKey(options: SearchDirectoryEntriesOptions): string {
  return JSON.stringify([
    options.root,
    options.query,
    options.pathFormat,
    options.pathQueryPolicy ?? "slashes",
    options.blankQueryBehavior ?? "none",
    options.includeFiles ?? false,
    options.includeDirectories ?? true,
    options.matchMode ?? "fuzzy",
    options.limit ?? null,
    options.respectGitIgnore ?? false,
    options.rootAliases ?? [],
    options.traversableHiddenDirectoryNames ?? [],
    options.maxDepth ?? null,
    options.maxEntriesScanned ?? null,
    options.browseMaxEntriesScanned ?? null,
    options.maxChildrenPerDirectory ?? null,
    options.confidentResultScanThreshold ?? null,
    options.deadlineMs ?? null,
  ]);
}

async function runSearchDirectoryEntries(
  options: SearchDirectoryEntriesOptions,
): Promise<DirectorySuggestionEntry[]> {
  const deadlineAt = options.deadlineAt ?? resolveDeadlineAt(options.deadlineMs);
  const root = await resolveDirectory(options.root);
  if (!root) return [];

  const gitIgnoredPaths = options.respectGitIgnore
    ? await loadGitIgnoredPaths(root)
    : new Set<string>();
  if (Date.now() >= deadlineAt) return [];
  const input = buildSearchInput(options, root, gitIgnoredPaths, deadlineAt);
  if (!input) return [];

  const exact =
    input.plan.browseExactPath || (input.matchMode === "suffix" && input.plan.isPathQuery)
      ? await findExactEntry(input)
      : null;
  if (exact && input.limit === 1) return [exact];

  const browsesRoot = input.plan.isPathQuery && !input.plan.normalizedQuery;
  const browsesAbsoluteParent = input.plan.browseExactPath === true;
  const ranked =
    browsesRoot || browsesAbsoluteParent ? await searchChildren(input) : await searchTree(input);
  const results = sortAndFormat(ranked, input.root, input.pathFormat).slice(0, input.limit);
  return exact
    ? [exact, ...results.filter((entry) => !sameEntry(entry, exact))].slice(0, input.limit)
    : results;
}

function buildSearchInput(
  options: SearchDirectoryEntriesOptions,
  root: string,
  gitIgnoredPaths: Set<string>,
  deadlineAt: number,
): SearchInput | null {
  const includeDirectories = options.includeDirectories ?? true;
  const includeFiles = options.includeFiles ?? false;
  if (!includeDirectories && !includeFiles) return null;

  const plan = parseQuery({
    query: options.query,
    root,
    configuredRoot: path.resolve(options.root),
    policy: options.pathQueryPolicy ?? "slashes",
    aliases: options.rootAliases ?? [],
    blankBehavior: options.blankQueryBehavior ?? "none",
  });
  if (!plan) return null;

  return {
    root,
    plan,
    includeDirectories,
    includeFiles,
    matchMode: options.matchMode ?? "fuzzy",
    pathFormat: options.pathFormat,
    hiddenDirectoryNames: new Set(options.traversableHiddenDirectoryNames ?? []),
    limit: normalizeLimit(options.limit),
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxEntriesScanned: options.maxEntriesScanned ?? DEFAULT_MAX_ENTRIES_SCANNED,
    browseMaxEntriesScanned: options.browseMaxEntriesScanned ?? DEFAULT_BROWSE_MAX_ENTRIES_SCANNED,
    maxChildrenPerDirectory: options.maxChildrenPerDirectory ?? DEFAULT_MAX_CHILDREN_PER_DIRECTORY,
    deadlineAt,
    confidentResultScanThreshold: options.confidentResultScanThreshold,
    gitIgnoredPaths,
  };
}

async function findExactEntry(input: SearchInput): Promise<DirectorySuggestionEntry | null> {
  if (!input.plan.normalizedQuery) return null;
  const visiblePath = path.resolve(input.root, input.plan.normalizedQuery);
  const resolvedPath = await realpath(visiblePath).catch(() => null);
  if (!resolvedPath || !isPathInsideRoot(input.root, resolvedPath)) return null;
  // No ignore filtering here: the caller named this exact path, so containment above is the
  // only question left to answer. Filtering belongs to discovery, not retrieval.
  const info = await stat(resolvedPath).catch(() => null);
  const kind = getEntryKind(info);
  if (
    !kind ||
    (kind === "directory" && !input.includeDirectories) ||
    (kind === "file" && !input.includeFiles)
  )
    return null;
  return formatEntry({ path: visiblePath, kind }, input.root, input.pathFormat);
}

interface SearchInput {
  root: string;
  plan: QueryPlan;
  includeDirectories: boolean;
  includeFiles: boolean;
  matchMode: DirectorySuggestionMatchMode;
  pathFormat: DirectorySuggestionPathFormat;
  hiddenDirectoryNames: Set<string>;
  limit: number;
  maxDepth: number;
  maxEntriesScanned: number;
  browseMaxEntriesScanned: number;
  maxChildrenPerDirectory: number;
  deadlineAt: number;
  confidentResultScanThreshold: number | undefined;
  gitIgnoredPaths: Set<string>;
}

async function searchChildren(input: SearchInput): Promise<RankedEntry[]> {
  const visibleParent = path.resolve(input.root, input.plan.parentPart || ".");
  const parent = await realpath(visibleParent).catch(() => null);
  if (!parent || !isPathInsideRoot(input.root, parent)) return [];
  if (isGitIgnoredPath(parent, input)) return [];
  if (isPastDeadline(input)) return [];
  const entries = await readChildren(parent, input.maxChildrenPerDirectory);
  const ranked: RankedEntry[] = [];
  let scanned = 0;
  for (const entry of entries) {
    if (scanned >= input.browseMaxEntriesScanned || isPastDeadline(input)) break;
    scanned += 1;
    if (!isPathInsideRoot(input.root, entry.resolvedPath) || !shouldDiscover(entry, input))
      continue;
    const candidate: TraversedEntry = {
      ...entry,
      visiblePath: path.join(visibleParent, entry.name),
      depth: 1,
    };
    if (shouldSuggest(candidate, input)) ranked.push(rank(candidate, input));
  }
  return ranked;
}

async function searchTree(input: SearchInput): Promise<RankedEntry[]> {
  if (!(input.maxEntriesScanned > 0)) return [];
  if (isPastDeadline(input)) return [];
  const roots = (await readChildren(input.root, input.maxChildrenPerDirectory)).filter((entry) =>
    isPathInsideRoot(input.root, entry.resolvedPath),
  );
  const visited = new Set<string>([input.root]);
  const branches = expandChildBranches(
    roots,
    { visiblePath: input.root, depth: 0 },
    input,
    visited,
  );
  const ranked: RankedEntry[] = [];
  let scanned = 0;
  const threshold = input.confidentResultScanThreshold;
  for await (const entry of roundRobin(branches)) {
    if (isPastDeadline(input)) break;
    scanned += 1;
    if (shouldSuggest(entry, input)) ranked.push(rank(entry, input));
    if (
      scanned >= input.maxEntriesScanned ||
      (threshold &&
        scanned >= threshold &&
        hasConfidentResult(ranked, input.plan.normalizedQuery || input.plan.searchTerm))
    )
      break;
  }
  return ranked;
}

async function* walkBranch(
  entry: TraversedEntry,
  input: SearchInput,
  visited: Set<string>,
): AsyncGenerator<TraversedEntry> {
  yield entry;
  if (
    entry.kind !== "directory" ||
    visited.has(entry.resolvedPath) ||
    entry.depth >= input.maxDepth
  )
    return;
  if (isPastDeadline(input)) return;
  visited.add(entry.resolvedPath);
  const children = (await readChildren(entry.resolvedPath, input.maxChildrenPerDirectory)).filter(
    (child) => isPathInsideRoot(input.root, child.resolvedPath),
  );
  const branches = expandChildBranches(
    children,
    { visiblePath: entry.visiblePath, depth: entry.depth },
    input,
    visited,
  );
  yield* roundRobin(branches);
}

// Turns a directory listing into walk branches, bounded by the scan budget and the deadline.
// The previous flatMap built one generator, one spread object and one joined path per child in
// a single synchronous block: a directory with 146,304 children (observed under a home root)
// blocked the event loop for about nine seconds and allocated tens of megabytes the scan budget
// could never have consumed.
function expandChildBranches(
  children: ChildEntry[],
  parent: { visiblePath: string; depth: number },
  input: SearchInput,
  visited: Set<string>,
): Array<AsyncGenerator<TraversedEntry>> {
  const cap = input.maxEntriesScanned > 0 ? input.maxEntriesScanned : children.length;
  const branches: Array<AsyncGenerator<TraversedEntry>> = [];
  for (const child of children) {
    if (branches.length >= cap || isPastDeadline(input)) break;
    if (!shouldDiscover(child, input)) continue;
    branches.push(
      walkBranch(
        {
          ...child,
          visiblePath: path.join(parent.visiblePath, child.name),
          depth: parent.depth + 1,
        },
        input,
        visited,
      ),
    );
  }
  return branches;
}

async function* roundRobin<T>(branches: Array<AsyncGenerator<T>>): AsyncGenerator<T> {
  let active = branches;
  while (active.length) {
    const nextRound: Array<AsyncGenerator<T>> = [];
    for (const branch of active) {
      const next = await branch.next();
      if (!next.done) {
        nextRound.push(branch);
        yield next.value;
      }
    }
    active = nextRound;
  }
}

function shouldDiscover(entry: ChildEntry, input: SearchInput): boolean {
  if (isGitIgnoredPath(entry.resolvedPath, input)) return false;
  if (entry.kind === "file") {
    return input.includeFiles && !entry.name.startsWith(".");
  }
  if (IGNORED_DIRECTORY_NAMES.has(entry.name)) return false;
  if (!entry.name.startsWith(".")) return true;
  return input.hiddenDirectoryNames.has(entry.name);
}

function isGitIgnoredPath(absolutePath: string, input: SearchInput): boolean {
  let candidate = absolutePath;
  while (candidate !== input.root && isPathInsideRoot(input.root, candidate)) {
    if (input.gitIgnoredPaths.has(candidate)) return true;
    candidate = path.dirname(candidate);
  }
  return false;
}

function shouldSuggest(entry: TraversedEntry, input: SearchInput): boolean {
  if (entry.name.startsWith(".")) return false;
  if (entry.kind === "directory" && !input.includeDirectories) return false;
  if (entry.kind === "file" && !input.includeFiles) return false;
  if (!input.plan.normalizedQuery) return true;
  if (input.matchMode === "suffix")
    return suffixMatches(entry.visiblePath, input.root, input.plan.normalizedQuery);
  return rank(entry, input).matchTier !== NO_MATCH_TIER;
}

function rank(entry: TraversedEntry, input: SearchInput): RankedEntry {
  const relativePath = normalizeRelativePath(input.root, entry.visiblePath);
  const lowerPath = relativePath.toLowerCase();
  const query = getRankQuery(input);
  const segments = lowerPath === "." ? [] : lowerPath.split("/");
  const pathScore = query ? scorePathMatch(query, relativePath) : null;
  const rankFields = input.plan.isPathQuery
    ? rankPathMatch(pathScore)
    : rankTextMatch({ query, lowerPath, pathFormat: input.pathFormat, pathScore, segments });
  return {
    path: entry.visiblePath,
    kind: entry.kind,
    ...rankFields,
    depth: relativePath === "." ? 0 : segments.length,
  };
}

function getRankQuery(input: SearchInput): string {
  return (
    input.plan.isPathQuery ? input.plan.normalizedQuery : input.plan.searchTerm
  ).toLowerCase();
}

function rankPathMatch(pathScore: MatchScore | null): RankFields {
  return {
    matchTier: pathScore ? Math.min(pathScore.tier, 4) : NO_MATCH_TIER,
    segmentIndex: NO_SEGMENT_INDEX,
    matchOffset: pathScore?.offset ?? NO_MATCH_OFFSET,
    fuzzyScore: pathScore?.spread ?? NO_FUZZY_SCORE,
  };
}

function rankTextMatch(input: {
  query: string;
  lowerPath: string;
  pathFormat: DirectorySuggestionPathFormat;
  pathScore: MatchScore | null;
  segments: string[];
}): RankFields {
  const { query, lowerPath, pathFormat, pathScore, segments } = input;
  const offset = lowerPath.indexOf(query);
  const fuzzyScore = scoreFuzzySubsequence(query, segments.at(-1) ?? "");
  if (!query) {
    return {
      matchTier: 3,
      segmentIndex: NO_SEGMENT_INDEX,
      matchOffset: NO_MATCH_OFFSET,
      fuzzyScore: NO_FUZZY_SCORE,
    };
  }
  const segmentRank = rankSegmentMatch({ query, segments, offset, fuzzyScore });
  if (segmentRank) return segmentRank;
  if (pathFormat === "relative" ? lowerPath.startsWith(query) : offset >= 0) {
    return {
      matchTier: 3,
      segmentIndex: NO_SEGMENT_INDEX,
      matchOffset: offset,
      fuzzyScore: fuzzyScore ?? NO_FUZZY_SCORE,
    };
  }
  if (fuzzyScore !== null) {
    return {
      matchTier: 4,
      segmentIndex: NO_SEGMENT_INDEX,
      matchOffset: offset >= 0 ? offset : NO_MATCH_OFFSET,
      fuzzyScore,
    };
  }
  return {
    matchTier: pathScore ? Math.min(pathScore.tier, 4) : NO_MATCH_TIER,
    segmentIndex: NO_SEGMENT_INDEX,
    matchOffset: pathScore?.offset ?? NO_MATCH_OFFSET,
    fuzzyScore: pathScore?.spread ?? NO_FUZZY_SCORE,
  };
}

function rankSegmentMatch(input: {
  query: string;
  segments: string[];
  offset: number;
  fuzzyScore: number | null;
}): RankFields | null {
  const { query, segments, offset, fuzzyScore } = input;
  const matchOffset = offset >= 0 ? offset : NO_MATCH_OFFSET;
  const exact = findSegmentMatchIndex(segments, (segment) => segment === query);
  if (exact >= 0) {
    return {
      matchTier: 0,
      segmentIndex: exact,
      matchOffset,
      fuzzyScore: fuzzyScore ?? NO_FUZZY_SCORE,
    };
  }
  const prefix = findSegmentMatchIndex(segments, (segment) => segment.startsWith(query));
  if (prefix >= 0) {
    return {
      matchTier: 1,
      segmentIndex: prefix,
      matchOffset,
      fuzzyScore: fuzzyScore ?? NO_FUZZY_SCORE,
    };
  }
  const substring = findSegmentMatchIndex(segments, (segment) => segment.includes(query));
  if (substring >= 0) {
    return {
      matchTier: 2,
      segmentIndex: substring,
      matchOffset,
      fuzzyScore: fuzzyScore ?? NO_FUZZY_SCORE,
    };
  }
  return null;
}

function sortAndFormat(
  entries: RankedEntry[],
  root: string,
  format: DirectorySuggestionPathFormat,
): DirectorySuggestionEntry[] {
  const unique = new Map<string, RankedEntry>();
  for (const entry of entries) {
    const key = `${entry.kind}:${entry.path}`;
    const existing = unique.get(key);
    if (!existing || compareRank(entry, existing) < 0) unique.set(key, entry);
  }
  return [...unique.values()].sort(compareRank).map((entry) => formatEntry(entry, root, format));
}

function formatEntry(
  entry: DirectorySuggestionEntry,
  root: string,
  format: DirectorySuggestionPathFormat,
): DirectorySuggestionEntry {
  return {
    path: format === "absolute" ? entry.path : normalizeRelativePath(root, entry.path),
    kind: entry.kind,
  };
}

function compareRank(left: RankedEntry, right: RankedEntry): number {
  return (
    left.matchTier - right.matchTier ||
    left.segmentIndex - right.segmentIndex ||
    left.matchOffset - right.matchOffset ||
    left.fuzzyScore - right.fuzzyScore ||
    left.depth - right.depth ||
    compareKinds(left.kind, right.kind) ||
    left.path.localeCompare(right.path)
  );
}

function compareKinds(left: DirectorySuggestionKind, right: DirectorySuggestionKind): number {
  if (left === right) return 0;
  return left === "directory" ? -1 : 1;
}

function hasConfidentResult(entries: RankedEntry[], query: string): boolean {
  const maxFuzzyScore = query.length * MAX_CONFIDENT_FUZZY_SKIPS_PER_CHARACTER;
  return entries.some(
    (entry) => entry.matchTier < 4 || (entry.matchTier === 4 && entry.fuzzyScore <= maxFuzzyScore),
  );
}

function suffixMatches(visiblePath: string, root: string, query: string): boolean {
  const querySegments = query.toLowerCase().split("/").filter(Boolean);
  if (querySegments.length === 0) return false;
  const pathSegments = normalizeRelativePath(root, visiblePath)
    .toLowerCase()
    .split("/")
    .filter(Boolean);
  const offset = pathSegments.length - querySegments.length;
  return (
    offset >= 0 && querySegments.every((segment, index) => pathSegments[offset + index] === segment)
  );
}

function parseQuery(input: {
  query: string;
  root: string;
  configuredRoot: string;
  policy: PathQueryPolicy;
  aliases: string[];
  blankBehavior: BlankQueryBehavior;
}): QueryPlan | null {
  const normalizedInput = normalizeQueryInput(input);
  if (!normalizedInput) return null;
  const { typed, rooted } = normalizedInput;
  const normalized = normalizedInput.normalized;

  if (!normalized) {
    const explicitlyBrowseRoot = rooted || typed === ".";
    if (!explicitlyBrowseRoot && input.blankBehavior !== "children") return null;
    return { isPathQuery: true, parentPart: "", searchTerm: "", normalizedQuery: "" };
  }
  if (normalizedInput.isAbsolute && isFilesystemRoot(input.root) && !normalized.includes("/")) {
    return {
      isPathQuery: true,
      parentPart: normalized,
      searchTerm: "",
      normalizedQuery: normalized,
      browseExactPath: true,
    };
  }
  const isPathQuery = rooted || (input.policy === "slashes" && normalized.includes("/"));
  const slash = normalized.lastIndexOf("/");
  return {
    isPathQuery,
    parentPart: isPathQuery && slash >= 0 ? normalized.slice(0, slash) : "",
    searchTerm: isPathQuery && slash >= 0 ? normalized.slice(slash + 1) : normalized,
    normalizedQuery: normalized,
  };
}

function normalizeQueryInput(input: {
  query: string;
  root: string;
  configuredRoot: string;
  aliases: string[];
}): { typed: string; normalized: string; rooted: boolean; isAbsolute: boolean } | null {
  const typed = input.query.trim().replace(/\\/g, "/");
  let normalized = typed;
  let rooted = false;
  let isAbsolute = false;
  for (const alias of input.aliases) {
    if (normalized === alias || normalized.startsWith(`${alias}/`)) {
      rooted = true;
      normalized = normalized.slice(alias.length).replace(/^\/+/, "");
      break;
    }
  }
  if (path.isAbsolute(normalized)) {
    isAbsolute = true;
    const browseAbsoluteDirectory = normalized.endsWith("/");
    const absolutePath = path.resolve(normalized);
    let queryRoot: string | null = null;
    if (isPathInsideRoot(input.root, absolutePath)) {
      queryRoot = input.root;
    } else if (isPathInsideRoot(input.configuredRoot, absolutePath)) {
      queryRoot = input.configuredRoot;
    }
    if (!queryRoot) return null;
    rooted = true;
    normalized = normalizeRelativePath(queryRoot, absolutePath);
    if (browseAbsoluteDirectory && normalized !== ".") {
      normalized = `${normalized}/`;
    }
  }
  if (normalized.startsWith("./")) rooted = true;
  normalized = normalized.replace(/^\.\/+/, "").replace(/\/{2,}/g, "/");
  if (normalized === "." && (rooted || typed === ".")) {
    normalized = "";
  }
  return { typed, normalized, rooted, isAbsolute };
}

function isFilesystemRoot(inputPath: string): boolean {
  return path.relative(path.parse(inputPath).root, inputPath) === "";
}

async function resolveDirectory(inputPath: string): Promise<string | null> {
  const resolved = await realpath(path.resolve(inputPath)).catch(() => null);
  if (!resolved) return null;
  const info = await stat(resolved).catch(() => null);
  return info?.isDirectory() ? resolved : null;
}

async function readChildren(directory: string, cap: number): Promise<ChildEntry[]> {
  const directoryInfo = await stat(directory).catch(() => null);
  if (!directoryInfo?.isDirectory()) return [];

  const cached = CAN_VALIDATE_DIRECTORY_CACHE_FROM_METADATA
    ? directoryListCache.get(directory)
    : undefined;
  let rawEntries: RawChildEntry[];
  if (
    cached &&
    cached.expiresAt > Date.now() &&
    cached.modifiedAtMs === directoryInfo.mtimeMs &&
    cached.changedAtMs === directoryInfo.ctimeMs
  ) {
    // The cap applies to cached listings too: a caller that lowered the cap must not inherit
    // the wider listing a default caller stored.
    rawEntries = cached.entries.length > cap ? cached.entries.slice(0, cap) : cached.entries;
  } else {
    // Cap before sorting: the walk can never consume more than its scan budget, and sorting a
    // six-figure listing with localeCompare costs hundreds of milliseconds per call.
    const dirents = await readdir(directory, { withFileTypes: true }).catch(() => [] as Dirent[]);
    const truncated = dirents.length > cap;
    const readable = truncated ? dirents.slice(0, cap) : dirents;
    rawEntries = readable
      .map(toRawChildEntry)
      .filter((entry): entry is RawChildEntry => entry !== null)
      .sort((left, right) => left.name.localeCompare(right.name));
    // A truncated listing is not a listing of the directory, so it must not be served to a
    // later request that reads with a wider cap.
    if (
      CAN_VALIDATE_DIRECTORY_CACHE_FROM_METADATA &&
      !truncated &&
      rawEntries.length <= DIRECTORY_LIST_CACHE_MAX_CHILDREN
    ) {
      directoryListCache.set(directory, {
        expiresAt: Date.now() + DIRECTORY_LIST_CACHE_TTL_MS,
        modifiedAtMs: directoryInfo.mtimeMs,
        changedAtMs: directoryInfo.ctimeMs,
        entries: rawEntries,
      });
      pruneCache();
    }
  }

  // No second sort: resolveChild keeps each entry's name, so the listing is already in name
  // order and re-sorting it was pure cost.
  return (await Promise.all(rawEntries.map((entry) => resolveChild(directory, entry)))).filter(
    (entry): entry is ChildEntry => entry !== null,
  );
}

async function loadGitIgnoredPaths(root: string): Promise<Set<string>> {
  const now = Date.now();
  const cached = gitIgnoredPathsCache.get(root);
  if (cached && cached.expiresAt > now) return cached.paths;

  const paths = runGitCommand(["ls-files", "-o", "-i", "--directory", "--exclude-standard", "-z"], {
    cwd: root,
    envOverlay: { GIT_OPTIONAL_LOCKS: "0" },
    timeout: 10_000,
  })
    .then(
      (result) =>
        new Set(
          result.stdout
            .split("\0")
            .filter(Boolean)
            .map((relativePath) => path.resolve(root, relativePath.replace(/\/$/, ""))),
        ),
    )
    .catch(() => new Set<string>());

  gitIgnoredPathsCache.set(root, {
    expiresAt: now + GIT_IGNORED_PATHS_CACHE_TTL_MS,
    paths,
  });
  pruneGitIgnoredPathsCache(now);
  return paths;
}

function pruneGitIgnoredPathsCache(now: number): void {
  if (gitIgnoredPathsCache.size <= GIT_IGNORED_PATHS_CACHE_MAX_ENTRIES) return;
  for (const [key, entry] of gitIgnoredPathsCache) {
    if (entry.expiresAt <= now) gitIgnoredPathsCache.delete(key);
  }
  while (gitIgnoredPathsCache.size > GIT_IGNORED_PATHS_CACHE_MAX_ENTRIES) {
    const key = gitIgnoredPathsCache.keys().next().value;
    if (!key) return;
    gitIgnoredPathsCache.delete(key);
  }
}

function toRawChildEntry(dirent: Dirent): RawChildEntry | null {
  if (dirent.isDirectory()) return { name: dirent.name, kind: "directory" };
  if (dirent.isFile()) return { name: dirent.name, kind: "file" };
  if (dirent.isSymbolicLink()) return { name: dirent.name, kind: "symlink" };
  return null;
}

async function resolveChild(directory: string, entry: RawChildEntry): Promise<ChildEntry | null> {
  const visiblePath = path.join(directory, entry.name);
  if (entry.kind !== "symlink") {
    return { name: entry.name, resolvedPath: visiblePath, kind: entry.kind };
  }

  const resolvedPath = await realpath(visiblePath).catch(() => null);
  if (!resolvedPath) return null;
  const info = await stat(resolvedPath).catch(() => null);
  const kind = getEntryKind(info);
  return kind ? { name: entry.name, resolvedPath, kind } : null;
}

function getEntryKind(info: Stats | null): DirectorySuggestionKind | null {
  if (info?.isDirectory()) return "directory";
  if (info?.isFile()) return "file";
  return null;
}

function pruneCache(): void {
  if (directoryListCache.size <= DIRECTORY_LIST_CACHE_MAX_ENTRIES) return;
  for (const [key, entry] of directoryListCache)
    if (entry.expiresAt <= Date.now()) directoryListCache.delete(key);
  while (directoryListCache.size > DIRECTORY_LIST_CACHE_MAX_ENTRIES) {
    const key = directoryListCache.keys().next().value;
    if (!key) return;
    directoryListCache.delete(key);
  }
}

function normalizeLimit(limit: number | undefined): number {
  const candidate =
    typeof limit === "number" && Number.isFinite(limit) ? Math.trunc(limit) : DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, candidate));
}

function normalizeRelativePath(root: string, absolutePath: string): string {
  const relative = path.relative(root, absolutePath);
  return relative ? relative.split(path.sep).join("/") : ".";
}

function scoreFuzzySubsequence(query: string, candidate: string): number | null {
  let queryIndex = 0;
  let first = -1;
  let previous = -1;
  let gaps = 0;
  for (let index = 0; index < candidate.length && queryIndex < query.length; index += 1) {
    if (candidate[index] !== query[queryIndex]) continue;
    if (first < 0) first = index;
    if (previous >= 0) gaps += index - previous - 1;
    previous = index;
    queryIndex += 1;
  }
  return queryIndex === query.length && first >= 0 ? first + gaps : null;
}

function findSegmentMatchIndex(
  segments: string[],
  predicate: (segment: string) => boolean,
): number {
  return segments.findIndex((segment) => predicate(segment));
}

function sameEntry(left: DirectorySuggestionEntry, right: DirectorySuggestionEntry): boolean {
  return left.path === right.path && left.kind === right.kind;
}
