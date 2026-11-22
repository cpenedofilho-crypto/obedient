// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
// Peças de tela comuns: cores com tema claro e escuro, botão com alvo de toque de 48 px e rótulo de
// acessibilidade, e um título de seção.
import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, useColorScheme, View } from "react-native";

export function useCores() {
  const escuro = useColorScheme() === "dark";
  return escuro
    ? { fundo: "#101114", cartao: "#1b1d22", texto: "#f2f2f4", fraco: "#a6a8b0", destaque: "#7aa7ff", perigo: "#ff8a80", borda: "#2c2f36" }
    : { fundo: "#f7f7f9", cartao: "#ffffff", texto: "#15161a", fraco: "#5b5e66", destaque: "#2457d6", perigo: "#b3261e", borda: "#dcdde2" };
}

export function Botao(p: { rotulo: string; aoTocar: () => void; tipo?: "principal" | "comum" | "perigo"; desligado?: boolean; dica?: string }) {
  const c = useCores();
  const cor = p.tipo === "principal" ? c.destaque : p.tipo === "perigo" ? c.perigo : c.borda;
  const textoCor = p.tipo === "principal" || p.tipo === "perigo" ? "#ffffff" : c.texto;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={p.rotulo}
      accessibilityHint={p.dica}
      accessibilityState={{ disabled: !!p.desligado }}
      disabled={p.desligado}
      onPress={p.aoTocar}
      style={({ pressed }) => [estilos.botao, { backgroundColor: cor, opacity: p.desligado ? 0.45 : pressed ? 0.8 : 1 }]}
    >
      <Text style={[estilos.botaoTexto, { color: textoCor }]}>{p.rotulo}</Text>
    </Pressable>
  );
}

export function Cartao(p: { titulo?: string; children: ReactNode }) {
  const c = useCores();
  return (
    <View style={[estilos.cartao, { backgroundColor: c.cartao, borderColor: c.borda }]}>
      {p.titulo ? <Text accessibilityRole="header" style={[estilos.titulo, { color: c.texto }]}>{p.titulo}</Text> : null}
      {p.children}
    </View>
  );
}

export function Texto(p: { children: ReactNode; fraco?: boolean; grande?: boolean }) {
  const c = useCores();
  return <Text style={{ color: p.fraco ? c.fraco : c.texto, fontSize: p.grande ? 28 : 16, lineHeight: p.grande ? 34 : 22, fontWeight: p.grande ? "700" : "400" }}>{p.children}</Text>;
}

export const estilos = StyleSheet.create({
  botao: { minHeight: 48, borderRadius: 10, paddingHorizontal: 16, justifyContent: "center", alignItems: "center", marginVertical: 4 },
  botaoTexto: { fontSize: 16, fontWeight: "600" },
  cartao: { borderWidth: 1, borderRadius: 12, padding: 16, marginBottom: 12, gap: 8 },
  titulo: { fontSize: 18, fontWeight: "700" },
  linha: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
});
