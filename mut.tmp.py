import io, os, shutil, subprocess, sys, glob
TESTS = sorted(glob.glob('test/supervisor/*.test.mjs'))
MUT=[
 ("R2-1 attempts keyed by resetAt equality again", "scripts/supervisor/pass.mjs",
  """  return state.attempts.filter((attempt) => attempt.at >= resetAt);""",
  """  return state.attempts.filter((attempt) => attempt.resetAt === resetAt);"""),
 ("R2-2 exact reading loses at the equality boundary", "scripts/supervisor/pass.mjs",
  """    if (obsReset !== null && obsReset >= limitedAt && obsReset <= limitedAt + WINDOW_SECONDS + config.graceSeconds) {""",
  """    if (obsReset !== null && obsReset > limitedAt && obsReset <= limitedAt + WINDOW_SECONDS + config.graceSeconds) {"""),
 ("R2-3 notification re-arms on estimate drift", "scripts/supervisor/pass.mjs",
  """  const notifiedRecently = Number.isFinite(state.notifiedAt) && now - state.notifiedAt < WINDOW_SECONDS;""",
  """  const notifiedRecently = false;"""),
 ("R2-4 the pass waits for a hung exit for ever", "scripts/supervisor/claude-runner.mjs",
  """  const completed = await Promise.race([handle.completion, grace.then(() => null)]);""",
  """  const completed = await handle.completion;"""),
 ("R2-5 a hung-but-successful activation burns a request", "scripts/supervisor/claude-runner.mjs",
  """    return streamed.sawSuccess
      ? { kind: 'success', startedAt }
      : { kind: 'failure', reason: 'exit-hung', startedAt };""",
  """    return { kind: 'failure', reason: 'exit-hung', startedAt };"""),
 ("R2-6 next-reset reports a past reset", "scripts/supervisor/cli.mjs",
  """    const aimable = target
      && target.resetAt > now
      && !(Number.isFinite(state.handledResetAt) && target.resetAt <= state.handledResetAt);""",
  """    const aimable = Boolean(target);"""),
 ("R2-7 the entry trap misses a corrupt config", "scripts/supervisor/supervisor.mjs",
  """  const result = await (async () => {
    const config = await new ConfigStore(data).read();""",
  """  const config = await new ConfigStore(data).read();
  const result = await (async () => {"""),
]
bak=".mutbak"; os.makedirs(bak, exist_ok=True); survived=[]
for name,path,old,new in MUT:
    src=io.open(path,encoding="utf-8",newline="").read(); key=os.path.basename(path)
    shutil.copyfile(path, os.path.join(bak,key)); norm=src.replace("\r\n","\n")
    if old not in norm:
        print(f"[{name}] DID NOT APPLY -- INVALID"); survived.append(name)
        shutil.copyfile(os.path.join(bak,key), path); continue
    io.open(path,"w",encoding="utf-8",newline="").write(norm.replace(old,new,1))
    r=subprocess.run(["node","--test","--test-reporter=tap",*TESTS],capture_output=True,text=True)
    caught="\n# fail 0" not in r.stdout
    hits=[l.strip() for l in r.stdout.splitlines() if l.startswith("not ok")]
    print(f"[{name}] {'CAUGHT' if caught else '*** SURVIVED ***'} {hits[0][:54] if hits else ''}", flush=True)
    if not caught: survived.append(name)
    shutil.copyfile(os.path.join(bak,key), path)
shutil.rmtree(bak, ignore_errors=True)
print("SURVIVORS:", survived if survived else "none")
sys.exit(1 if survived else 0)
