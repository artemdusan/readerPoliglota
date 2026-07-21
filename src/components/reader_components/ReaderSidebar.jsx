import { Badge, Button, Drawer, Group, NavLink, Stack, Text } from "@mantine/core";

export default function ReaderSidebar({
  sidebarOpen,
  onClose,
  onBack,
  book,
  chapterCount,
  tocItems,
  hrefToIndex,
  chapterStatusMap,
  currentChapterHref,
  onGoToHref,
  languageMeta,
  languageOrder,
}) {
  return (
    <Drawer
      opened={sidebarOpen}
      onClose={onClose}
      size={290}
      padding="sm"
      zIndex={1100}
      title={
        <Stack gap={2}>
          <Button variant="subtle" size="compact-sm" onClick={onBack} w="fit-content" px={4}>
            ← Biblioteka
          </Button>
          <Text fw={600} lineClamp={2}>{book?.title || "…"}</Text>
          {book?.author && (
            <Text size="xs" c="dimmed">
              {book.author} · {chapterCount} rozdz.
            </Text>
          )}
        </Stack>
      }
    >
      <Stack gap={0}>
        {tocItems.map((item, index) => {
          const itemHref = (item.href || "").split("#")[0];
          const chapterIndex = hrefToIndex[itemHref] ?? -1;
          const status = chapterStatusMap[chapterIndex];
          const translationBadges = [...(status?.translationLangs || [])]
            .sort(
              (a, b) =>
                (languageOrder.get(a) ?? Number.MAX_SAFE_INTEGER) -
                (languageOrder.get(b) ?? Number.MAX_SAFE_INTEGER),
            )
            .map(
              (code) =>
                languageMeta[code] || {
                  code,
                  flag: code.toUpperCase(),
                  name: code,
                },
            );

          return (
            <NavLink
              key={itemHref || `${index}-${item.title || "toc"}`}
              active={currentChapterHref === itemHref}
              onClick={() => onGoToHref(itemHref)}
              pl={8 + Math.min(item.depth ?? 0, 3) * 14}
              label={
                <Group gap={6} wrap="nowrap" justify="space-between">
                  <Text size="sm" lineClamp={2}>{item.title || "—"}</Text>
                  {translationBadges.length > 0 && (
                    <Group gap={3} wrap="nowrap">
                      {translationBadges.map((lang) => (
                        <Badge
                          key={`${itemHref}-${lang.code}`}
                          size="xs"
                          variant="outline"
                          title={`Tłumaczenie: ${lang.name}`}
                          aria-label={`Tłumaczenie: ${lang.name}`}
                          px={4}
                        >
                          {lang.code}
                        </Badge>
                      ))}
                    </Group>
                  )}
                </Group>
              }
            />
          );
        })}
      </Stack>
    </Drawer>
  );
}
