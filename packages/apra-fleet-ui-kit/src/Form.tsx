import type { ChangeEvent } from "react";
import { colors, spacing, typography } from "./tokens.js";

const labelStyle = {
  display: "block",
  marginBottom: spacing.xs,
  fontSize: typography.fontSizeSm,
  color: colors.textSecondary
} as const;

const fieldWrapperStyle = {
  marginBottom: spacing.md
} as const;

const inputStyle = {
  width: "100%",
  boxSizing: "border-box" as const,
  padding: spacing.sm,
  backgroundColor: colors.surfaceRaised,
  border: `1px solid ${colors.border}`,
  borderRadius: "4px",
  color: colors.textPrimary,
  fontFamily: typography.fontFamily,
  fontSize: typography.fontSizeMd
};

export interface TextFieldProps {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  required?: boolean;
  placeholder?: string;
}

/** Labelled single-line text/password/number input, controlled by the caller. */
export function TextField({
  label,
  name,
  value,
  onChange,
  type = "text",
  required,
  placeholder
}: TextFieldProps) {
  return (
    <div style={fieldWrapperStyle}>
      <label htmlFor={name} style={labelStyle}>
        {label}
        {required ? " *" : ""}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        value={value}
        required={required}
        placeholder={placeholder}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
        style={inputStyle}
      />
    </div>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectFieldProps {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  required?: boolean;
}

/** Labelled single-select dropdown, controlled by the caller. */
export function SelectField({ label, name, value, onChange, options, required }: SelectFieldProps) {
  return (
    <div style={fieldWrapperStyle}>
      <label htmlFor={name} style={labelStyle}>
        {label}
        {required ? " *" : ""}
      </label>
      <select
        id={name}
        name={name}
        value={value}
        required={required}
        onChange={(event: ChangeEvent<HTMLSelectElement>) => onChange(event.target.value)}
        style={inputStyle}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export interface RadioOption {
  value: string;
  label: string;
}

export interface RadioGroupProps {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  options: RadioOption[];
}

/** Labelled single-choice radio group, controlled by the caller. */
export function RadioGroup({ label, name, value, onChange, options }: RadioGroupProps) {
  return (
    <fieldset style={{ ...fieldWrapperStyle, border: "none", padding: 0, margin: 0 }}>
      <legend style={labelStyle}>{label}</legend>
      {options.map((option) => (
        <label
          key={option.value}
          style={{
            display: "flex",
            alignItems: "center",
            gap: spacing.xs,
            marginBottom: spacing.xs,
            fontSize: typography.fontSizeMd,
            color: colors.textPrimary
          }}
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
          />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}
