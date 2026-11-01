export function Avatar({ name, initials }: { name: string; initials?: string }) {
  return (
    <span className="sp-avatar" aria-hidden="true">
      {initials ??
        name
          .split(" ")
          .map((part) => part[0])
          .slice(0, 2)
          .join("")}
    </span>
  );
}
