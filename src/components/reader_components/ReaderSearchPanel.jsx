import { ActionIcon, Group, ScrollArea, Stack, Text, TextInput, UnstyledButton } from "@mantine/core";

export default function ReaderSearchPanel({
  inputRef,
  searchQuery,
  onSearchQueryChange,
  searchMatches,
  activeSearchIdx,
  onGoToSearchMatch,
  onClose,
}) {
  const hasQuery = Boolean(searchQuery.trim());

  return (
    <div className="reader-search-panel">
      <Group gap="xs" wrap="nowrap">
        <TextInput
          ref={inputRef}
          type="search"
          flex={1}
          size="sm"
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            if (!searchMatches.length) return;
            onGoToSearchMatch(activeSearchIdx + (event.shiftKey ? -1 : 1));
          }}
          placeholder="Szukaj tekstu w tym rozdziale"
        />

        <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
          {hasQuery
            ? searchMatches.length
              ? `${activeSearchIdx + 1}/${searchMatches.length}`
              : "0 wyników"
            : "Wpisz frazę"}
        </Text>

        <ActionIcon
          variant="default"
          onClick={() => onGoToSearchMatch(activeSearchIdx - 1)}
          disabled={!searchMatches.length}
          title="Poprzedni wynik"
        >
          {"<"}
        </ActionIcon>
        <ActionIcon
          variant="default"
          onClick={() => onGoToSearchMatch(activeSearchIdx + 1)}
          disabled={!searchMatches.length}
          title="Następny wynik"
        >
          {">"}
        </ActionIcon>
        <ActionIcon variant="default" onClick={onClose} title="Zamknij wyszukiwanie">
          ✕
        </ActionIcon>
      </Group>

      {hasQuery && (
        <ScrollArea.Autosize mah={220} mt="xs">
          <Stack gap={2}>
            {searchMatches.length ? (
              searchMatches.map((match, index) => (
                <UnstyledButton
                  key={`${match.blockId}-${index}`}
                  onClick={() => onGoToSearchMatch(index)}
                  px="xs"
                  py={4}
                  style={{
                    borderRadius: 4,
                    background: index === activeSearchIdx ? "var(--bg-hover)" : undefined,
                  }}
                >
                  <Group gap="xs" wrap="nowrap">
                    <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
                      s. {match.page + 1}
                    </Text>
                    <Text size="sm" lineClamp={1} flex={1}>{match.preview}</Text>
                    {match.count > 1 && (
                      <Text size="xs" c="dimmed">x{match.count}</Text>
                    )}
                  </Group>
                </UnstyledButton>
              ))
            ) : (
              <Text size="sm" c="dimmed" p="xs">Brak trafień w tym rozdziale.</Text>
            )}
          </Stack>
        </ScrollArea.Autosize>
      )}
    </div>
  );
}
