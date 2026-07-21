import { ActionIcon, Button, Group, ScrollArea, Stack, Text, UnstyledButton } from "@mantine/core";

export default function ReaderBookmarkMenu({
  menuRef,
  hasCurrentPageBookmark,
  currentPage,
  totalPages,
  bookmarkList,
  onAddBookmark,
  onJumpToBookmark,
  onRemoveBookmark,
  formatBookmarkProgress,
}) {
  const currentProgress =
    totalPages > 1
      ? Math.round(((currentPage / (totalPages - 1)) + Number.EPSILON) * 100)
      : 0;

  return (
    <div className="reader-float-menu" ref={menuRef}>
      <Stack gap="sm">
        <div>
          <Text fw={600}>Zakładki</Text>
          <Text size="xs" c="dimmed">
            Zapisz bieżący postęp i zsynchronizuj go z kontem.
          </Text>
        </div>

        <Button
          variant={hasCurrentPageBookmark ? "filled" : "default"}
          onClick={onAddBookmark}
          title="Zapisz zakładkę"
        >
          {hasCurrentPageBookmark ? "Zapisano ten postęp" : "Zapisz zakładkę"} · {currentProgress}%
        </Button>

        <ScrollArea.Autosize mah={260}>
          <Stack gap={4}>
            {bookmarkList.length ? (
              bookmarkList.map((bookmark) => (
                <Group key={bookmark.id} gap={4} wrap="nowrap" align="flex-start">
                  <UnstyledButton
                    flex={1}
                    onClick={() => onJumpToBookmark(bookmark)}
                    px="xs"
                    py={4}
                    style={{ borderRadius: 4 }}
                  >
                    <Text size="sm" fw={600}>
                      {bookmark.chapterTitle || `Rozdział ${bookmark.chapterIndex + 1}`}
                    </Text>
                    <Text size="xs" c="dimmed">
                      Postęp {formatBookmarkProgress(bookmark)}
                    </Text>
                    {bookmark.preview && (
                      <Text size="xs" c="dimmed" lineClamp={2}>{bookmark.preview}</Text>
                    )}
                  </UnstyledButton>

                  <ActionIcon
                    variant="subtle"
                    size="sm"
                    onClick={() => onRemoveBookmark(bookmark.id)}
                    title="Usuń zakładkę"
                    aria-label="Usuń zakładkę"
                  >
                    ✕
                  </ActionIcon>
                </Group>
              ))
            ) : (
              <Text size="sm" c="dimmed">Brak zapisanych zakładek.</Text>
            )}
          </Stack>
        </ScrollArea.Autosize>
      </Stack>
    </div>
  );
}
