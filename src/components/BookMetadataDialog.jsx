import { useState } from "react";
import { Button, Group, Modal, Select, Stack, TextInput } from "@mantine/core";
import { BOOK_SOURCE_LANGUAGES } from "../constants/bookLanguages";

const LANGUAGE_OPTIONS = BOOK_SOURCE_LANGUAGES.map((language) => ({
  value: language.code,
  label: language.label,
}));

export default function BookMetadataDialog({
  book,
  title = "Edytuj metadane",
  confirmLabel = "Zapisz zmiany",
  onConfirm,
  onCancel,
}) {
  const [bookTitle, setBookTitle] = useState(book?.title || "");
  const [author, setAuthor] = useState(book?.author || "");
  const [lang, setLang] = useState(book?.lang || "");

  function handleConfirm() {
    onConfirm({
      ...book,
      title: bookTitle.trim() || "Bez tytułu",
      author: author.trim(),
      lang,
    });
  }

  return (
    <Modal opened onClose={onCancel} title={title} centered>
      <Stack gap="sm">
        <TextInput
          label="Tytuł"
          value={bookTitle}
          onChange={(e) => setBookTitle(e.target.value)}
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
        <Group justify="flex-end" mt="sm">
          <Button variant="subtle" onClick={onCancel}>Anuluj</Button>
          <Button onClick={handleConfirm}>{confirmLabel}</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
