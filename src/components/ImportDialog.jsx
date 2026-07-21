import { useState, useRef } from "react";
import {
  Button,
  Group,
  Image,
  Modal,
  Select,
  Stack,
  TextInput,
  UnstyledButton,
} from "@mantine/core";
import { BOOK_SOURCE_LANGUAGES } from "../constants/bookLanguages";

const LANGUAGE_OPTIONS = BOOK_SOURCE_LANGUAGES.map((language) => ({
  value: language.code,
  label: language.label,
}));

export default function ImportDialog({ parsed, onConfirm, onCancel }) {
  const [title, setTitle] = useState(parsed.title || "");
  const [author, setAuthor] = useState(parsed.author || "");
  const [lang, setLang] = useState(parsed.lang || "");
  const [cover, setCover] = useState(parsed.cover || null);
  const coverInputRef = useRef(null);

  function handleCoverFile(file) {
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = (e) => setCover(e.target.result);
    reader.readAsDataURL(file);
  }

  function handleConfirm() {
    onConfirm({
      ...parsed,
      title: title.trim() || "Bez tytułu",
      author: author.trim(),
      lang,
      cover,
    });
  }

  return (
    <Modal opened onClose={onCancel} title="Dodaj książkę" centered>
      <Group align="flex-start" gap="md" wrap="nowrap">
        <UnstyledButton
          onClick={() => coverInputRef.current?.click()}
          title="Kliknij, aby zmienić okładkę"
          style={{
            width: 96,
            flexShrink: 0,
            aspectRatio: '2 / 3',
            border: '1px solid var(--border-soft)',
            borderRadius: 4,
            overflow: 'hidden',
            display: 'grid',
            placeItems: 'center',
            fontSize: 32,
          }}
        >
          {cover ? <Image src={cover} alt="okładka" h="100%" fit="cover" /> : '📖'}
        </UnstyledButton>

        <input
          ref={coverInputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            handleCoverFile(e.target.files[0]);
            e.target.value = "";
          }}
        />

        <Stack gap="sm" flex={1}>
          <TextInput
            label="Tytuł"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Tytuł książki"
            data-autofocus
          />
          <TextInput
            label="Autor"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            placeholder="Autor"
          />
          <Select
            label="Język książki"
            data={LANGUAGE_OPTIONS}
            value={lang}
            onChange={(value) => setLang(value ?? "")}
            allowDeselect={false}
          />
        </Stack>
      </Group>

      <Group justify="flex-end" mt="md">
        <Button variant="subtle" onClick={onCancel}>Anuluj</Button>
        <Button onClick={handleConfirm}>Dodaj książkę</Button>
      </Group>
    </Modal>
  );
}
