import { useState, useEffect } from "react";
import {
  ActionIcon,
  Button,
  Divider,
  Group,
  NativeSelect,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from "@mantine/core";
import { UiIcon } from "./ReaderIcons";
import { FONT_SIZE_MAX, FONT_SIZE_MIN, getVoiceId } from "./readerUtils";

function getVoiceNoteText(voiceLoadState) {
  if (voiceLoadState === "unsupported") {
    return "Ta przeglądarka nie udostępnia listy głosów Web Speech.";
  }
  if (voiceLoadState === "empty") {
    return "Lista głosów jest pusta. Na mobilnym Chromium pojawia się to często, gdy system nie ma zainstalowanych danych TTS albo przeglądarka nie odsłoniła jeszcze głosów.";
  }
  return "Brak osobnych głosów dla tego języka. Przeglądarka użyje domyślnego głosu systemowego.";
}

function Tool({ icon, label, active, onClick, disabled, title, toolRef }) {
  return (
    <UnstyledButton
      ref={toolRef}
      onClick={onClick}
      disabled={disabled}
      title={title}
      px="xs"
      py={6}
      style={{
        borderRadius: 6,
        textAlign: "center",
        flex: 1,
        background: active ? "var(--bg-hover)" : undefined,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Stack gap={2} align="center">
        {icon}
        <Text size="xs">{label}</Text>
      </Stack>
    </UnstyledButton>
  );
}

function VoiceSelect({ icon, label, langLabel, voices, value, onChange }) {
  return (
    <Group gap="xs" wrap="nowrap">
      <Group gap={6} wrap="nowrap" w={130}>
        <UiIcon name={icon} />
        <div>
          <Text size="sm">{label}</Text>
          <Text size="xs" c="dimmed">{langLabel}</Text>
        </div>
      </Group>
      <NativeSelect
        flex={1}
        size="xs"
        value={value}
        disabled={!voices.length}
        onChange={(event) => onChange(event.target.value)}
        data={[
          { value: "", label: voices.length ? "Domyślny głos" : "Głos systemowy" },
          ...voices.map((voice) => ({ value: getVoiceId(voice), label: voice.name })),
        ]}
      />
    </Group>
  );
}

export default function ReaderSettingsMenu({
  menuRef,
  bookmarkToggleRef,
  hasCurrentPageBookmarks,
  isTtsActive,
  onToggleTts,
  ttsButtonTitle,
  ttsButtonLabel,
  isTtsPlaying,
  isTtsPaused,
  hasTtsAvailable,
  fontSize,
  onChangeFontSize,
  onSetFontSize,
  searchOpen,
  isFullscreen,
  onToolSearch,
  onToolBookmarks,
  onToggleFullscreen,
  showAddTranslation,
  showRegenerateTranslation,
  onAddTranslation,
  onRegenerateTranslation,
  onDeleteTranslation,
  sourceLanguageLabel,
  targetLanguageLabel,
  sourceVoices,
  targetVoices,
  showTargetVoiceSelect,
  showVoiceNote,
  voiceLoadState,
  ttsSourceVoice,
  ttsTargetVoice,
  onSourceVoiceChange,
  onTargetVoiceChange,
}) {
  const [fsInput, setFsInput] = useState(String(fontSize));
  useEffect(() => {
    setFsInput(String(fontSize));
  }, [fontSize]);

  return (
    <div className="reader-float-menu" ref={menuRef}>
      <Stack gap="sm">
        <Group gap={4} wrap="nowrap">
          <Tool
            icon={<UiIcon name="search" />}
            label="Szukaj"
            active={searchOpen}
            onClick={onToolSearch}
            title="Szukaj w rozdziale"
          />
          <Tool
            toolRef={bookmarkToggleRef}
            icon={<UiIcon name="bookmark" />}
            label="Zakładki"
            onClick={onToolBookmarks}
            title="Zakładki"
          />
          <Tool
            icon={<UiIcon name={isTtsPlaying && !isTtsPaused ? "pause" : "play"} strokeWidth={2} />}
            label={ttsButtonLabel}
            active={isTtsActive}
            onClick={onToggleTts}
            disabled={!hasTtsAvailable}
            title={ttsButtonTitle}
          />
          <Tool
            icon={<UiIcon name={isFullscreen ? "fullscreenExit" : "fullscreen"} />}
            label="Ekran"
            onClick={onToggleFullscreen}
            title={isFullscreen ? "Wyjdź z pełnego ekranu" : "Pełny ekran"}
          />
        </Group>

        <Divider label="Widok" labelPosition="left" />

        <Group gap="xs" wrap="nowrap">
          <Group gap={6} wrap="nowrap" flex={1}>
            <UiIcon name="type" />
            <Text size="sm">Rozmiar</Text>
          </Group>
          <Button variant="default" size="compact-sm" onClick={() => onChangeFontSize(-1)}>
            A-
          </Button>
          <TextInput
            w={56}
            size="xs"
            type="number"
            min={FONT_SIZE_MIN}
            max={FONT_SIZE_MAX}
            value={fsInput}
            onChange={(e) => setFsInput(e.target.value)}
            onBlur={() => {
              const n = Number(fsInput);
              if (Number.isFinite(n) && n >= 1) onSetFontSize?.(n);
              else setFsInput(String(fontSize));
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.target.blur();
            }}
            aria-label="Rozmiar czcionki"
          />
          <Button variant="default" size="compact-sm" onClick={() => onChangeFontSize(1)}>
            A+
          </Button>
        </Group>

        {(showAddTranslation || showRegenerateTranslation) && (
          <>
            <Divider label="Tłumaczenie" labelPosition="left" />
            <Group gap="xs" wrap="nowrap">
              <Group gap={6} wrap="nowrap" flex={1}>
                <UiIcon name="translate" />
                <Text size="sm">Rozdział</Text>
              </Group>
              {showAddTranslation ? (
                <Button size="compact-sm" leftSection={<UiIcon name="sparkles" />} onClick={onAddTranslation}>
                  Dodaj
                </Button>
              ) : (
                <>
                  <Button
                    variant="default"
                    size="compact-sm"
                    leftSection={<UiIcon name="refresh" />}
                    onClick={onRegenerateTranslation}
                  >
                    Regeneruj
                  </Button>
                  <ActionIcon variant="default" onClick={onDeleteTranslation} title="Usuń tłumaczenie">
                    <UiIcon name="delete" />
                  </ActionIcon>
                </>
              )}
            </Group>
          </>
        )}

        <Divider label="Głosy TTS" labelPosition="left" />

        <VoiceSelect
          icon="voice"
          label="Oryginał"
          langLabel={sourceLanguageLabel}
          voices={sourceVoices}
          value={ttsSourceVoice}
          onChange={onSourceVoiceChange}
        />

        {showTargetVoiceSelect && (
          <VoiceSelect
            icon="translate"
            label="Tłumaczenie"
            langLabel={targetLanguageLabel}
            voices={targetVoices}
            value={ttsTargetVoice}
            onChange={onTargetVoiceChange}
          />
        )}

        {showVoiceNote && (
          <Text size="xs" c="dimmed">{getVoiceNoteText(voiceLoadState)}</Text>
        )}
      </Stack>
    </div>
  );
}
