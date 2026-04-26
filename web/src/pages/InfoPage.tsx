import { marked } from "marked";
import readmeRaw from "../../../README.md?raw";
import { Breadcrumb } from "../components/Breadcrumb.js";

const html = marked(readmeRaw) as string;

export function InfoPage() {
  return (
    <div className="page">
      <div style={{ maxWidth: 760, margin: "0 auto" }}>
        <Breadcrumb crumbs={[{ label: "Dashboard", href: "/" }, { label: "Info" }]} />
        <div className="card info-page-body" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}
