"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    ("standalone" in navigator &&
      Boolean((navigator as Navigator & { standalone?: boolean }).standalone))
  );
}

function subscribeStandalone(callback: () => void) {
  const media = window.matchMedia("(display-mode: standalone)");
  media.addEventListener("change", callback);
  window.addEventListener("appinstalled", callback);
  return () => {
    media.removeEventListener("change", callback);
    window.removeEventListener("appinstalled", callback);
  };
}

export function PwaRegister() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js", {
        scope: "/",
        updateViaCache: "none",
      });
    }
  }, []);

  return null;
}

export function InstallAppButton() {
  const [installPrompt, setInstallPrompt] =
    useState<InstallPromptEvent | null>(null);
  const installed = useSyncExternalStore(
    subscribeStandalone,
    isStandalone,
    () => false,
  );

  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    const onInstalled = () => {
      setInstallPrompt(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const install = async () => {
    if (installPrompt) {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      if (choice.outcome === "accepted") setInstallPrompt(null);
      return;
    }

    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    window.alert(
      isIos
        ? "Tap the Share button, then choose Add to Home Screen."
        : "Open your browser menu and choose Install app or Add to Home Screen.",
    );
  };

  if (installed) {
    return <span className="installed-pill">App installed</span>;
  }

  return (
    <button className="install-app" onClick={install}>
      Install app
    </button>
  );
}
