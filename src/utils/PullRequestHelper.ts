import fs from "node:fs";
import path from "node:path";
import { t } from "../i18n/index.js";

export function generatePRTitle(issueIid: number, issueTitle: string): string {
  return `feat(#${issueIid}): ${issueTitle}`;
}

export function generatePRDescription(options: {
  issueIid: number;
  issueTitle: string;
  issueDescription: string;
  branchName: string;
  planDir?: string;
}): string {
  const { issueIid, issueTitle, issueDescription, branchName, planDir } =
    options;

  const metaLines = [
    `- Issue: #${issueIid}`,
    `- ${t("pr.title")}: ${issueTitle}`,
    `- ${t("pr.branch")}: \`${branchName}\``,
  ];

  const sections: string[] = [
    t("pr.relatedIssue"),
    ``,
    ...metaLines,
    ``,
    t("pr.issueDescription"),
    ``,
    issueDescription || t("pr.noDescription"),
  ];

  if (planDir) {
    const summaryFiles = [
      { filename: "01-plan.md", label: t("pr.summaryFiles.01-plan.md") },
      {
        filename: "02-verify-report.md",
        label: t("pr.summaryFiles.02-verify-report.md"),
      },
    ];

    const planSections: string[] = [];
    for (const { filename, label } of summaryFiles) {
      const filePath = path.join(
        planDir,
        ".claude-plan",
        `issue-${issueIid}`,
        filename,
      );
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, "utf-8");
        const summary = extractSummary(content);
        if (summary) {
          planSections.push(`### ${label}\n\n${summary}`);
        }
      }
    }

    if (planSections.length > 0) {
      sections.push("", t("pr.aiSummary"), "", ...planSections);
    }
  }

  sections.push("", "---", t("pr.autoCreated"));
  return sections.join("\n");
}

function extractSummary(content: string, maxLines = 20): string {
  const lines = content.split("\n");
  if (lines.length <= maxLines) return content.trim();
  return (
    lines.slice(0, maxLines).join("\n").trim() + "\n\n" + t("pr.truncated")
  );
}
