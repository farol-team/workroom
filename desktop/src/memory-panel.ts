// The memory side-panel: what the room knows, who is in it, and how work is
// done here. Moved out of main.ts whole (#283) — the markup ids, the event
// order and every catch's wording are the ones the window always had. What
// stays behind crosses as deps: the room on screen, the API calls, and the
// notice strip — rendering moved, state did not.

import type { Channel } from "./api";
import type { RepoInfo } from "./channel-settings";
import { identity } from "./rules";
import { escape } from "./timeline";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export interface MemoryPanelDeps {
  memory(slug: string): Promise<Array<{ title: string; overview?: string | null;
                                        trust: string }>>;
  skills(slug: string): Promise<Array<{ title: string; overview?: string | null }>>;
  members(slug: string): Promise<Array<{ name: string; role: string }>>;
  remember(slug: string, title: string, detail: string): Promise<unknown>;
  writeSkill(slug: string, title: string, body: string): Promise<unknown>;
  /// The open channel's repository, when its folder is one — the panel leads
  /// with its standing rules, and whether there are any is the machine's answer.
  channelRepo(slug: string): Promise<RepoInfo | null>;
  currentChannel(): Channel | null;
  say(message: string): void;
}

export interface MemoryPanel {
  /// What `open()` calls where it called the three renders before the split.
  renderAll(): void;
  /// Whether the panel is on screen — how call sites redraw only a panel
  /// somebody is looking at, without reaching into the markup themselves.
  visible(): boolean;
}

export function createMemoryPanel(deps: MemoryPanelDeps): MemoryPanel {
  /// One line of a panel: a mark, a title, and the overview under it. Memory and
  /// skills are listed the same way and marked differently, because a fact and a
  /// procedure are read the same way and must not be mistaken for each other.
  function entryEl(into: string, mark: string, title: string, overview: string | null, extra = "") {
    const el = document.createElement("div");
    el.className = `entry ${extra}`;
    el.innerHTML = `<div class="t"><span class="mark">${mark}</span></div><div class="o"></div>`;
    el.querySelector(".t")!.append(title);
    el.querySelector<HTMLElement>(".o")!.textContent = overview ?? "";
    $(into).append(el);
  }

  /// The standing rules every session in a repository works under, drawn with
  /// what the room has learned but never written into it — they are this
  /// client's prompt to the agent, not the room's memory (#205). First in the
  /// list, because they are always true while every learned entry ages; the
  /// AUTO mark is what keeps a rule nobody learned from reading as a fact
  /// somebody taught.
  function renderGitBoundary(info: RepoInfo) {
    const el = document.createElement("div");
    el.className = "entry auto";
    el.innerHTML = `<div class="t"><span class="auto-badge">AUTO</span></div><div class="o"></div>`;
    el.querySelector(".t")!.append("Repository session boundary");
    el.querySelector<HTMLElement>(".o")!.textContent =
      `Sessions here work on agent/<topic> branches and never commit or push to ` +
      `${info.default_branch}. Commits carry a Co-Authored-By trailer.`;
    $("memory-list").prepend(el);
  }

  async function renderMemory() {
    const current = deps.currentChannel();
    if (!current) return;
    const [ entries, repo ] = await Promise.all([
      deps.memory(current.slug),
      deps.channelRepo(current.slug),
    ]);
    $("memory-uri").textContent = current.memory_uri;
    $("memory-list").innerHTML = "";
    if (repo) renderGitBoundary(repo);
    for (const e of entries) {
      entryEl("memory-list", e.trust === "human" ? "●" : "○", e.title, e.overview ?? null, e.trust);
    }
  }

  /// Who is in the room, so a name in the timeline is a colleague rather than a
  /// stranger.
  async function renderMembers() {
    const current = deps.currentChannel();
    if (!current) return;
    const members = await deps.members(current.slug);
    const box = $("members");
    box.innerHTML = "";
    for (const m of members) {
      const id = identity({ kind: "user", name: m.name });
      const el = document.createElement("div");
      el.className = "member";
      el.innerHTML = `<span class="avatar" style="--hue:${id.hue}">${escape(id.initials)}</span>`;
      el.append(m.name + (m.role === "owner" ? " · owner" : ""));
      box.append(el);
    }
  }

  /// Procedures, alongside what the room knows but never mixed into it. A fact
  /// goes stale and a procedure does not, and a reader has to be able to tell.
  async function renderSkills() {
    const current = deps.currentChannel();
    if (!current) return;
    const skills = await deps.skills(current.slug);
    $("skill-list").innerHTML = "";
    for (const s of skills) {
      entryEl("skill-list", "▸", s.title, s.overview ?? null, "skill");
    }
  }

  function renderAll() {
    renderMemory();
    renderSkills();
    renderMembers();
  }

  $("memory-toggle").addEventListener("click", () => {
    const memory = $("memory");
    memory.hidden = !memory.hidden;
    if (!memory.hidden) renderAll();
  });

  $("memory-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = $<HTMLInputElement>("memory-title").value.trim();
    const detail = $<HTMLTextAreaElement>("memory-detail").value.trim();
    const current = deps.currentChannel();
    if (!current || !title || !detail) return;
    try {
      await deps.remember(current.slug, title, detail);
      $<HTMLInputElement>("memory-title").value = "";
      $<HTMLTextAreaElement>("memory-detail").value = "";
      renderMemory();
    } catch (err) {
      deps.say(`The room did not take that. ${String(err)}`);
    }
  });

  $("skill-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = $<HTMLInputElement>("skill-title").value.trim();
    const body = $<HTMLTextAreaElement>("skill-body").value.trim();
    const current = deps.currentChannel();
    if (!current || !title || !body) return;
    try {
      await deps.writeSkill(current.slug, title, body);
      $<HTMLInputElement>("skill-title").value = "";
      $<HTMLTextAreaElement>("skill-body").value = "";
      renderSkills();
    } catch (err) {
      deps.say(`The skill was not saved. ${String(err)}`);
    }
  });

  return { renderAll, visible: () => !$("memory").hidden };
}
