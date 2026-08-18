import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Card } from "@acos/ui";
import { api } from "../../lib/api.js";
import { PermissionsPanel } from "./PermissionsPanel.js";

type Tab = "general" | "permissions";

export function SettingsView() {
  const [tab, setTab] = useState<Tab>("permissions");

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-xl font-bold text-acos-fg0">Ayarlar</h1>
        <p className="mt-1 text-sm text-acos-fg1">
          Şirket ayarlarını, izinleri ve tercihleri buradan yönetin.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-acos-line">
        <button
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            tab === "general"
              ? "border-b-2 border-accent-400 text-acos-fg0"
              : "text-acos-fg1 hover:text-acos-fg0"
          }`}
          onClick={() => setTab("general")}
        >
          Genel
        </button>
        <button
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            tab === "permissions"
              ? "border-b-2 border-accent-400 text-acos-fg0"
              : "text-acos-fg1 hover:text-acos-fg0"
          }`}
          onClick={() => setTab("permissions")}
        >
          İzinler
        </button>
      </div>

      {/* Content */}
      {tab === "general" && (
        <Card title="Genel Ayarlar">
          <p className="text-sm text-acos-fg1">Yakında eklenecek...</p>
        </Card>
      )}

      {tab === "permissions" && <PermissionsPanel />}
    </div>
  );
}
