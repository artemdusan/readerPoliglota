import { Button, Group, Text } from "@mantine/core";

export default function ReaderMissingLangBanner({
  langCode,
  languages,
  onGenerate,
  onDismiss,
}) {
  const lang = languages.find((item) => item.code === langCode);

  return (
    <div className="missing-lang-banner">
      <Text size="sm">
        Brak tłumaczenia {lang?.flag} {lang?.label || langCode}
      </Text>

      <Group gap="xs">
        <Button size="compact-sm" onClick={onGenerate}>Wygeneruj</Button>
        <Button size="compact-sm" variant="subtle" onClick={onDismiss}>Oryginał</Button>
      </Group>
    </div>
  );
}
