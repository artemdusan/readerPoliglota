import { useEffect, useState } from "react";
import {
  Anchor,
  Button,
  Group,
  Modal,
  PasswordInput,
  Progress,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { formatLastSync, getLastSyncTs } from "../utils/formatUtils";
import {
  getUsername,
  isLoggedIn,
  login,
  logout,
  onAuthChange,
} from "../sync/cfAuth";
import { syncAll } from "../sync/cfSync";
import { getSyncActivity, subscribeSyncActivity } from "../sync/syncActivity";
import { getWorkerUrl } from "../config/workerUrl";

const SYNC_INTERVAL_OPTIONS = [
  { value: "5", label: "Co 5 minut" },
  { value: "15", label: "Co 15 minut" },
  { value: "30", label: "Co 30 minut" },
  { value: "60", label: "Co 1 godzinę" },
  { value: "180", label: "Co 3 godziny" },
  { value: "360", label: "Co 6 godzin" },
  { value: "720", label: "Co 12 godzin" },
];

export default function Settings({ settings, onUpdateSetting, onClose }) {
  const [cfConnected, setCfConnected] = useState(() => isLoggedIn());
  const [accountName, setAccountName] = useState(() => getUsername());
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authWorking, setAuthWorking] = useState(false);
  const [syncActivity, setSyncActivity] = useState(() => getSyncActivity());
  const [lastSync, setLastSync] = useState(getLastSyncTs);

  useEffect(
    () =>
      onAuthChange((loggedIn, nextUsername) => {
        setCfConnected(loggedIn);
        setAccountName(nextUsername);
      }),
    [],
  );

  useEffect(() => subscribeSyncActivity(setSyncActivity), []);

  useEffect(() => {
    function handleSynced() {
      setLastSync(getLastSyncTs() ?? Date.now());
    }

    window.addEventListener("vocabapp:synced", handleSynced);
    return () => window.removeEventListener("vocabapp:synced", handleSynced);
  }, []);

  async function handleAuth(event) {
    event.preventDefault();
    setAuthWorking(true);
    setAuthError("");

    try {
      await login(username, password);
      setUsername("");
      setPassword("");
    } catch (error) {
      setAuthError(error.message);
    } finally {
      setAuthWorking(false);
    }
  }

  const syncProgress = syncActivity.progress;
  const isSyncing = syncActivity.phase === "syncing";

  return (
    <Modal opened onClose={onClose} title="Konto i synchronizacja" centered>
      <Stack gap="lg">
        <Stack gap="xs">
          <Text fw={600} size="sm">Konto</Text>

          {cfConnected ? (
            <>
              <Group gap="xs">
                {accountName && <Text fw={600}>{accountName}</Text>}
                <Text size="sm" c="dimmed">• Zalogowany</Text>
                <Button variant="subtle" size="compact-sm" onClick={logout}>
                  Wyloguj
                </Button>
              </Group>

              <Text size="sm" c="dimmed">
                Ostatni sync: {formatLastSync(lastSync)}
              </Text>

              <Anchor
                href={`${getWorkerUrl()}/admin`}
                target="_blank"
                rel="noopener noreferrer"
                size="sm"
              >
                Dashboard →
              </Anchor>

              {isSyncing && syncProgress && (
                <Stack gap={4}>
                  <Progress
                    value={
                      syncProgress.total > 0
                        ? (syncProgress.done / syncProgress.total) * 100
                        : 0
                    }
                  />
                  <Text size="sm" c="dimmed">
                    {syncProgress.done} / {syncProgress.total}
                  </Text>
                </Stack>
              )}
            </>
          ) : (
            <form onSubmit={handleAuth}>
              <Stack gap="sm" align="flex-start">
                <TextInput
                  w="100%"
                  placeholder="Nazwa użytkownika"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  required
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <PasswordInput
                  w="100%"
                  placeholder="Hasło"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  minLength={8}
                  autoComplete="current-password"
                />
                {authError && (
                  <Text size="sm" c="red">{authError}</Text>
                )}
                <Button type="submit" loading={authWorking}>
                  Zaloguj
                </Button>
              </Stack>
            </form>
          )}
        </Stack>

        <Select
          label="Synchronizacja w tle"
          description="Aplikacja będzie próbowała odświeżać dane w tle, gdy jesteś online i konto jest połączone."
          data={SYNC_INTERVAL_OPTIONS}
          value={String(settings.syncIntervalMinutes ?? 30)}
          onChange={(value) =>
            value && onUpdateSetting("syncIntervalMinutes", Number(value))
          }
          allowDeselect={false}
        />
      </Stack>
    </Modal>
  );
}
