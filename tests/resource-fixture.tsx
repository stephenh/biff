import { useState } from "react";
import { createRoot } from "react-dom/client";
import { latestVersion, post, useResource } from "../src/api";
import { notifyResource, useResourceEvents } from "../src/resourceEvents";

interface Snapshot { version?: number; label: string }

/** Exercise actual resource hooks without a feature's extra state hiding reconciliation failures. */
function ResourceFixture() {
  const [source, setSource] = useState("first");
  const [saving, setSaving] = useState(false);
  const versioned = new URLSearchParams(window.location.search).has("versioned");
  const endpoint = `/api/resource-fixture/${source}`;
  const resource = useResource<Snapshot>(endpoint, { reconcile: versioned ? latestVersion : undefined });
  useResourceEvents(resource.refreshQuiet, "resource-fixture");

  /** Capture this resource's setter before the request, just as a background mutation does. */
  async function save() {
    setSaving(true);
    try { resource.setData(await post<Snapshot>(endpoint, {})); }
    finally { setSaving(false); }
  }

  return <main>
    <output aria-label="Resource data">{resource.data?.label ?? "Loading"}</output>
    <output aria-label="Resource error">{resource.error}</output>
    <output aria-label="Resource loading">{String(resource.loading)}</output>
    <output aria-label="Mutation pending">{String(saving)}</output>
    <button onClick={resource.refresh}>Refresh</button>
    <button onClick={() => void save()}>Save</button>
    <button onClick={() => resource.setData({ version: 4, label: "Stream snapshot" })}>Stream update</button>
    <button onClick={() => setSource("second")}>Switch resource</button>
    <button onClick={() => notifyResource("resource-fixture")}>Invalidate resource</button>
  </main>;
}

createRoot(document.getElementById("root")!).render(<ResourceFixture />);
