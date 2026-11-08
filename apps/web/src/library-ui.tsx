import type { ComponentProps } from "react";
import { Button } from "@palimora/ui";
import { Icon } from "./icons";

export function IconButton({
  label,
  icon,
  ...props
}: Omit<ComponentProps<typeof Button>, "children"> & {
  label: string;
  icon: ComponentProps<typeof Icon>["name"];
}) {
  return (
    <Button
      {...props}
      className={
        "button " +
        (props.tone ?? "normal") +
        " icon-button " +
        (props.className ?? "")
      }
      aria-label={label}
      title={label}
    >
      <Icon name={icon} />
    </Button>
  );
}
