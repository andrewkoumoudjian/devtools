import { StrictMode, lazy } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Owners } from "./pages/Owners";
import { Repos } from "./pages/Repos";
import { RepoLayout } from "./pages/RepoLayout";
import { TreePage } from "./pages/TreePage";
import { CommitsPage } from "./pages/CommitsPage";
import { ForgePullDetailPage, ForgeTabPage } from "./pages/ForgeTabPage";
import { track } from "./data";
import "./styles.css";
import "./walgit.css";
import "./clone.css";
import "./typography.css";
import "./home.css";

const BlobPage = lazy(() => track(import("./pages/BlobPage")).then((module) => ({ default: module.BlobPage })));
const CommitPage = lazy(() => track(import("./pages/CommitPage")).then((module) => ({ default: module.CommitPage })));

createRoot(document.getElementById("root")!).render(<StrictMode><BrowserRouter><Routes><Route element={<Layout />}><Route index element={<Owners />} /><Route path=":owner" element={<Repos />} /><Route path=":owner/:repo" element={<RepoLayout />}><Route index element={<TreePage />} /><Route path="tree/*" element={<TreePage />} /><Route path="blob/*" element={<BlobPage />} /><Route path="commits" element={<CommitsPage />} /><Route path="commits/*" element={<CommitsPage />} /><Route path="commit/:sha" element={<CommitPage />} /><Route path="issues" element={<ForgeTabPage tab="issues" />} /><Route path="pulls" element={<ForgeTabPage tab="pulls" />} /><Route path="pulls/:number" element={<ForgePullDetailPage />} /><Route path="actions" element={<ForgeTabPage tab="actions" />} /><Route path="releases" element={<ForgeTabPage tab="releases" />} /><Route path="notifications" element={<ForgeTabPage tab="notifications" />} /><Route path="settings" element={<ForgeTabPage tab="settings" />} /></Route></Route></Routes></BrowserRouter></StrictMode>);
