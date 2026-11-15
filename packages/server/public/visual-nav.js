// SPDX-License-Identifier: AGPL-3.0-only
// Presentation-only navigation: never changes permissions, session or server data.
// Deep links to dashboard sections always open the real dashboard.
const home = document.getElementById("inicio-obedient");
const panel = document.getElementById("tela-painel");
const nav = document.querySelector(".obedient-menu");
const dashboardIds = new Set(["t-missoes","t-pedidos","t-autorizacoes","t-atividade","t-conexoes","t-aprendizado","t-dados","m-objetivo"]);
function syncVisualView() {
  if (!home || !panel) return;
  const id = decodeURIComponent(location.hash.slice(1));
  const isHome = id === "inicio-obedient";
  panel.classList.toggle("obedient-view-home", isHome);
  panel.classList.toggle("obedient-view-dashboard", !isHome);
  if (nav instanceof HTMLDetailsElement && (isHome || dashboardIds.has(id))) nav.open = false;
}
window.addEventListener("hashchange", syncVisualView);
syncVisualView();
