import {
  ActionIcon,
  Button,
  Divider,
  Group,
  NativeSelect,
  Stack,
  Text,
} from "@mantine/core";
import { UiIcon } from "./ReaderIcons";
import { getVoiceId } from "./readerUtils";

function getVoiceNoteText(voiceLoadState) {
  if (voiceLoadState === "unsupported") {
    return "Ta przeglądarka nie udostępnia listy głosów Web Speech.";
  }
  if (voiceLoadState === "empty") {
    return "Lista głosów jest pusta. Na mobilnym Chromium pojawia się to często, gdy system nie ma zainstalowanych danych TTS albo przeglądarka nie odsłoniła jeszcze głosów.";
  }
  return "Brak osobnych głosów dla tego języka. Przeglądarka użyje domyślnego głosu systemowego.";
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
  isFullscreen,
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
  return (
    <div className="reader-float-menu" ref={menuRef}>
      <Stack gap="sm">
        <Group gap="xs" wrap="nowrap">
          <Group gap={6} wrap="nowrap" flex={1}>
            <UiIcon name={isFullscreen ? "fullscreenExit" : "fullscreen"} />
            <Text size="sm">Ekran</Text>
          </Group>
          <Button variant="default" size="compact-sm" onClick={onToggleFullscreen}>
            {isFullscreen ? "Wyjdź z pełnego ekranu" : "Pełny ekran"}
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
