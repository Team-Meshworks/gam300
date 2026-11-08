export interface DirectoryAccount {
  id: string;
  name: string;
  account: string;
  role: string;
  status: string;
}
export interface DirectoryOrganization {
  id: string;
  name: string;
  description: string;
  isActive?: boolean;
  counts?: { projects: number; facilitators: number; creators: number };
  accounts: readonly DirectoryAccount[];
  projects: readonly {
    id: string;
    title: string;
    creator: string;
    status: string;
    isPublic?: boolean;
    cover?: string;
  }[];
}
