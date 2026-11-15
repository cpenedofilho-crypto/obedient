// SPDX-License-Identifier: AGPL-3.0-only
// Navegação só de apresentação: nunca muda permissão, sessão nem dado do servidor.
// Três vistas da referência: início imersivo (trilho de ícones), menu de vidro e Mission Control.
// Link para uma seção do painel sempre abre o Mission Control de verdade.
// @ts-check

const home = document.getElementById("inicio-obedient");
const painel = document.getElementById("tela-painel");
const menu = document.getElementById("menu-obedient");
const abridores = /** @type {HTMLButtonElement[]} */ ([...document.querySelectorAll(".abre-menu")]);
const fechar = /** @type {HTMLButtonElement | null} */ (document.querySelector(".menu-fechar"));
/** @type {HTMLElement | null} */
let quemAbriu = null;

function sincronizarVista() {
  if (!home || !painel) return;
  const id = decodeURIComponent(location.hash.slice(1));
  const ehInicio = id === "inicio-obedient";
  painel.classList.toggle("obedient-view-home", ehInicio);
  painel.classList.toggle("obedient-view-dashboard", !ehInicio);
  for (const a of document.querySelectorAll(".trilho-item[href], .menu-links a")) {
    const atual = a.getAttribute("href") === `#${id}` || (!id && a.getAttribute("href") === "#t-pedidos");
    a.classList.toggle("atual", atual);
    if (atual) a.setAttribute("aria-current", "location");
    else a.removeAttribute("aria-current");
  }
  fecharMenu(false);
}

function abrirMenu(/** @type {HTMLElement} */ origem) {
  if (!menu) return;
  quemAbriu = origem;
  menu.hidden = false;
  for (const b of abridores) b.setAttribute("aria-expanded", "true");
  /** @type {HTMLElement | null} */ (menu.querySelector(".menu-links a") ?? fechar)?.focus();
}

function fecharMenu(/** @type {boolean} */ devolverFoco) {
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  for (const b of abridores) b.setAttribute("aria-expanded", "false");
  if (devolverFoco) quemAbriu?.focus();
}

for (const b of abridores) b.addEventListener("click", () => abrirMenu(b));
fechar?.addEventListener("click", () => fecharMenu(true));
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && menu && !menu.hidden) fecharMenu(true);
});
// Mesmo hash de antes (o hashchange não dispara): fecha o menu do mesmo jeito.
menu?.addEventListener("click", (ev) => {
  if (ev.target instanceof Element && ev.target.closest("a")) fecharMenu(false);
});

// Ponto no sino quando há pedido esperando: lê a lista que o app já desenhou, não pede nada ao servidor.
const pedidos = document.getElementById("pedidos");
function sincronizarSino() {
  const n = pedidos ? pedidos.children.length : 0;
  for (const p of document.querySelectorAll(".ponto-pedidos")) /** @type {HTMLElement} */ (p).hidden = n === 0;
  for (const a of document.querySelectorAll('a.mc-sino, .trilho-item[href="#t-pedidos"]'))
    a.setAttribute("aria-label", n === 0 ? "Esperando você: nada" : n === 1 ? "Esperando você: 1 pedido" : `Esperando você: ${n} pedidos`);
}
if (pedidos) new MutationObserver(sincronizarSino).observe(pedidos, { childList: true });
sincronizarSino();

// Saudação pela hora do aparelho. Sem nome: o painel não traz o nome da pessoa, e não se inventa um.
const saudacao = document.getElementById("saudacao");
if (saudacao) {
  const h = new Date().getHours();
  saudacao.textContent = h < 5 ? "Boa noite" : h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite";
}

// "Fale comigo..." e "Executar" levam ao campo da missão já com o cursor nele.
for (const a of document.querySelectorAll('a[href="#m-objetivo"]'))
  a.addEventListener("click", () => setTimeout(() => document.getElementById("m-objetivo")?.focus(), 0));

window.addEventListener("hashchange", sincronizarVista);
sincronizarVista();
