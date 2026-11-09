import { useState, type ReactNode } from "react";
import { OrganizationDirectory } from "../directory/OrganizationDirectory";
import { accounts } from "./fixtures";
import cover from "./museum-cover.png";
const organizations = [
  {
    id: "ridgeview",
    name: "Ridgeview Secondary School",
    description: "Fictional school for demonstrating the directory.",
    accounts,
    projects: [
      {
        id: "silk-road",
        title: "The Silk Road: A Journey Through History",
        creator: "Ms Tan",
        status: "Private",
        cover,
      },
    ],
  },
  {
    id: "lakeside",
    name: "Lakeside Secondary School",
    description: "A separate fictional organisation with its own accounts.",
    accounts: [
      { id: "lee", name: "Ms Lee", account: "@mslee", role: "Teachers", status: "Active" },
      { id: "alex", name: "Alex Chen", account: "@alexchen", role: "Students", status: "Active" },
    ],
    projects: [],
  },
];
export function AccountsExample({
  onPreview,
}: {
  onPreview: (title: string, body: ReactNode) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  return (
    <OrganizationDirectory
      organizations={organizations}
      selectedId={selectedId}
      onSelect={setSelectedId}
      onPreview={onPreview}
    />
  );
}
