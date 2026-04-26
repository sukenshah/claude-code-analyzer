import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Layout } from "./components/Layout.js";
import { Dashboard } from "./pages/Dashboard.js";
import { ProjectPage } from "./pages/ProjectPage.js";
import { SessionPage } from "./pages/SessionPage.js";
import { InfoPage } from "./pages/InfoPage.js";

export default function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/project/:key" element={<ProjectPage />} />
          <Route path="/session/:id" element={<SessionPage />} />
          <Route path="/info" element={<InfoPage />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}
