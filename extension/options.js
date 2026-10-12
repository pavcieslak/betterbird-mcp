const $ = (id) => document.getElementById(id);

async function refreshStatus() {
  try {
    const r = await messenger.runtime.sendMessage({ type: "status" });
    $("status").textContent = "Status: " + (r && r.state);
  } catch { $("status").textContent = "Status: unknown"; }
}

(async () => {
  const s = await messenger.storage.local.get({ hubUrl: "ws://127.0.0.1:8765/ext", token: "" });
  $("hubUrl").value = s.hubUrl;
  $("token").value = s.token;
  refreshStatus();
  setInterval(refreshStatus, 2000);
})();

$("save").addEventListener("click", async () => {
  await messenger.storage.local.set({ hubUrl: $("hubUrl").value.trim(), token: $("token").value.trim() });
  await messenger.runtime.sendMessage({ type: "reconnect" });
  setTimeout(refreshStatus, 800);
});
