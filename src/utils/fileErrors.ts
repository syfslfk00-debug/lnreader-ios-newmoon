export const isPickerCancellation = (error: unknown): boolean => {
  const code = (error as { code?: string } | null)?.code;
  return code === 'USER_CANCELED' || code === 'DOCUMENT_PICKER_CANCELED';
};
