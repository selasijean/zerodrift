"use client";

import { useSyncEngine, useRecords, useUndoRedo } from "sync-engine/react";
import { Issue } from "@/sync/models";

export default function Page() {
  const { sm: store } = useSyncEngine();
  const { data: issues } = useRecords(Issue);
  const { undo, redo, canUndo, canRedo } = useUndoRedo();

  const createIssue = () => {
    const issue = new Issue();
    issue.title = `Issue ${new Date().toLocaleTimeString()}`;
    issue.priority = Math.floor(Math.random() * 4);
    issue.save();
  };

  const renameIssue = (issue: Issue) => {
    const title = prompt("New title:", issue.title);
    if (title != null && title !== "") {
      issue.title = title;
      issue.save();
    }
  };

  const deleteIssue = (issue: Issue) => {
    store.deleteModel(issue);
  };

  return (
    <main style={{ maxWidth: 640, margin: "40px auto", padding: "0 20px" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 500 }}>Sync engine demo</h1>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={undo} disabled={!canUndo} style={btn}>Undo</button>
          <button onClick={redo} disabled={!canRedo} style={btn}>Redo</button>
          <button onClick={createIssue} style={{ ...btn, background: "#1d9e75", color: "#fff", border: "1px solid #0f6e56" }}>
            + New issue
          </button>
        </div>
      </header>

      <p style={{ color: "#888", fontSize: 13, marginBottom: 16 }}>
        Open two tabs. Edits sync in real-time via SSE.
        {issues.length === 0 && " Create an issue to get started."}
      </p>

      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {issues.map((issue) => (
          <li key={issue.id} style={row}>
            <div style={{ flex: 1 }}>
              <span style={{ fontWeight: 500 }}>{issue.title}</span>
              <span style={{ fontSize: 12, color: "#999", marginLeft: 8 }}>
                P{issue.priority ?? 0}
              </span>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={() => renameIssue(issue)} style={btn}>Rename</button>
              <button onClick={() => deleteIssue(issue)} style={{ ...btn, color: "#a32d2d" }}>Delete</button>
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}

const btn: React.CSSProperties = {
  padding: "5px 10px",
  border: "1px solid #d4d4d4",
  borderRadius: 6,
  background: "#fff",
  cursor: "pointer",
  fontSize: 13,
};

const row: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  padding: "10px 14px",
  border: "1px solid #e8e8e8",
  borderRadius: 8,
  marginBottom: 6,
  background: "#fff",
};
