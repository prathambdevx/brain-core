// The knowledge files live where the project's sessions read them (liveDir); brainDir inside the project's
// repo is their versioned copy. Every kept edit is one commit, pushed. Anything that looks like a secret stops it.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Project } from "./types.ts";

const SECRET = /xox[abpcr]-\w|gh[pousr]_[A-Za-z0-9]{20}|sk-ant-|AKIA[0-9A-Z]{12}|shpat_[0-9a-f]{10}|password\s*[:=]\s*\S|postgres(?:ql)?:\/\/[^\s:/]+:[^\s@]+@/i;

export function versions(p: Project) {
  const rel = relative(p.repoDir, p.brainDir) || ".";
  const names = p.files.map((f) => f.name);
  const git = async (args: string[], input?: string) => {
    for (let i = 0; ; i++) {
      const g = Bun.spawn(["git", ...args], { cwd: p.repoDir, stdin: input ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
      if (input) { g.stdin!.write(input); g.stdin!.end(); }
      const [code, out, err] = await Promise.all([g.exited, new Response(g.stdout).text(), new Response(g.stderr).text()]);
      // A terminal git command holding the lock: wait and retry rather than lose the commit.
      if (code !== 0 && /index\.lock/.test(err) && i < 10) { await Bun.sleep(2000); continue; }
      return { ok: code === 0, out: out.trim(), raw: out, err: err.trim() }; // raw: a patch must keep its trailing lines
    }
  };
  let chain: Promise<unknown> = Promise.resolve();
  const queued = <T>(job: () => Promise<T>): Promise<T> => { const r = chain.then(job, job); chain = r.catch(() => {}); return r; };
  const push = () => git(["push", "-q", "origin", "HEAD"]).then((r) => { if (!r.ok) console.error(`[brain:${p.name}] push failed:`, r.err); });

  return {
    // Copies the live files into brainDir and commits only brainDir, so other work in the repo is never swept in.
    commit: (message: string): Promise<{ ok: boolean; commit?: string; error?: string }> => queued(async () => {
      mkdirSync(p.brainDir, { recursive: true });
      for (const f of names) {
        const src = join(p.liveDir, f);
        if (!existsSync(src)) continue;
        const hit = readFileSync(src, "utf8").match(SECRET);
        if (hit) return { ok: false, error: `${f} looks like it contains a credential (${hit[0].slice(0, 12)}…); nothing committed` };
        copyFileSync(src, join(p.brainDir, f));
      }
      await git(["add", "--", rel]);
      if ((await git(["diff", "--cached", "--quiet", "--", rel])).ok) return { ok: true };
      const c = await git(["commit", "-q", "-m", message, "--", rel]);
      if (!c.ok) return { ok: false, error: c.err };
      push();
      return { ok: true, commit: (await git(["rev-parse", "--short", "HEAD"])).out };
    }),
    // A file as it was at a commit, or null if it didn't exist there.
    at: async (rev: string, file: string) => { const r = await git(["show", `${rev}:${rel}/${file}`]); return r.ok ? r.raw : null; },
    since: async (rev: string | undefined) => {
      const r = await git(["log", "--reverse", "--format=%h%x09%s", ...(rev ? [`${rev}..HEAD`] : ["-n", "30"]), "--", rel]);
      return r.ok && r.out ? r.out.split("\n").map((l) => { const [commit, ...m] = l.split("\t"); return { commit, message: m.join("\t") }; }) : [];
    },
    head: async () => (await git(["rev-parse", "--short", "HEAD"])).out,
    // Undoes one commit's changes on top of whatever came after; changes nothing if they overlap.
    revert: (commit: string, why: string): Promise<{ ok: boolean; error?: string; files?: string[] }> => queued(async () => {
      const patch = await git(["show", "--format=", commit, "--", rel]);
      if (!patch.ok || !patch.out) return { ok: false, error: "no brain changes in that commit" };
      const check = await git(["apply", "-R", "--check"], patch.raw);
      if (!check.ok) return { ok: false, error: `later edits overlap it: ${check.err.split("\n")[0]}` };
      await git(["apply", "-R"], patch.raw);
      const files = [...patch.out.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1].slice(rel.length + 1)).filter((f) => names.includes(f));
      for (const f of files) writeFileSync(join(p.liveDir, f), readFileSync(join(p.brainDir, f)));
      await git(["add", "--", rel]);
      const c = await git(["commit", "-q", "-m", `agent: revert ${commit} (${why})`, "--", rel]);
      if (!c.ok) return { ok: false, error: c.err };
      push();
      return { ok: true, files };
    }),
  };
}
