// Fictional, in-memory examples only; these never represent authenticated users
export const students = [
  { id: "aisyah", name: "Aisyah", account: "@aisyah", className: "4A" },
  { id: "christopher", name: "Christopher Low", account: "@christopherlow", className: "4A" },
  { id: "jonathan", name: "Jonathan Lim", account: "@jonathanlim", className: "4A" },
  { id: "joshua", name: "Joshua", account: "@josh", className: "4A" },
  { id: "yuqian", name: "Song Yu Qian", account: "@yuqian", className: "4B" },
  { id: "junjie", name: "Tan Jun Jie", account: "@tanjj", className: "4B" },
  { id: "reverie", name: "Reverie Smith", account: "@reveriesmith", className: "4B" },
] as const;
export const accounts = [
  ...students.map((student) => ({
    id: student.id,
    name: student.name,
    account: student.account,
    role: "Students",
    status: "Active",
  })),
  { id: "teacher", name: "Ms Tan", account: "@MsTan", role: "Teachers", status: "Active" },
  { id: "inactive", name: "Jordan Ng", account: "@jordan", role: "Students", status: "Disabled" },
];
