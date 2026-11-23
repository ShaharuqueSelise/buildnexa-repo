// Documents: every read and write goes through the documents Function (functions/documents),
// because only the Function can check the person's project role against each folder's rules.
// Every change answers with the fresh listing, which replaces the cached one.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FUNCTIONS, callFunction } from "../../lib/blocks/functions";
import { MAX_FILE_BYTES, put } from "../files/files";
import type { NewAttachment, UploadSlot } from "../files/files";

export type DocVersion = {
  versionNo: number;
  fileId: string;
  fileName: string;
  contentType?: string;
  sizeBytes?: number;
  uploadedBy?: string;
  uploadedByName?: string;
  note?: string;
  uploadedAt: string;
  restoredFrom?: number;
};

export type DocRow = {
  ItemId: string;
  projectId: string;
  folderId: string;
  name: string;
  ext: string;
  contentType?: string;
  currentVersion: number;
  sizeBytes?: number;
  /** Newest first. */
  versions: DocVersion[];
  createdByUserId: string;
  createdByName?: string;
  createdAt: string;
  updatedByUserId?: string;
  updatedByName?: string;
  updatedAt: string;
  trashed?: boolean;
  trashedAt?: string;
  trashedByName?: string;
  /** Link to the current version, valid until the listing's linksExpireAt. */
  url?: string;
};

export type DocFolder = { ItemId: string; key: string; name: string; viewRoles: string[]; uploadRoles: string[]; canUpload: boolean };

export type DocListing = {
  role: string;
  archived: boolean;
  can: { manage: boolean; folderAccess: boolean };
  folders: DocFolder[];
  /** Folders of the project that aren't shared with the person's role. */
  hiddenFolders: number;
  /** Until when the documents' `url` links can be used. */
  linksExpireAt?: string;
  documents: DocRow[];
};

// Same list as the Function (functions/documents ALLOWED_EXT).
export const DOC_EXTENSIONS = ["pdf", "docx", "doc", "xlsx", "xls", "csv", "pptx", "dwg", "jpg", "jpeg", "png", "zip", "msg", "eml", "txt"];
export const extOf = (name: string) => (/\.([a-z0-9]{1,8})$/i.exec(name)?.[1] ?? "").toLowerCase();

/** Why a file can't go into Documents, or undefined when it can. */
export function docRefusal(file: File): "type" | "size" | "empty" | undefined {
  if (!DOC_EXTENSIONS.includes(extOf(file.name))) return "type";
  if (file.size === 0) return "empty";
  if (file.size > MAX_FILE_BYTES) return "size";
  return undefined;
}

const key = (projectId?: string) => ["documents", projectId ?? ""];
const call = <T,>(body: Record<string, unknown>) => callFunction<T>(FUNCTIONS.documents, body);

export function useDocuments(projectId?: string) {
  return useQuery({
    queryKey: key(projectId),
    queryFn: () => call<DocListing>({ action: "list", projectId }),
    enabled: Boolean(projectId && FUNCTIONS.documents)
  });
}

type ActionBody =
  | { action: "addFiles"; folderId: string; files: NewAttachment[]; note?: string }
  | { action: "newVersion"; documentId: string; file: NewAttachment; note?: string }
  | { action: "restoreVersion"; documentId: string; versionNo: number }
  | { action: "rename"; documentId: string; name: string }
  | { action: "move"; documentId: string; folderId: string }
  | { action: "trash" | "restore"; documentId: string }
  | { action: "createFolder"; name: string; viewRoles: string[]; uploadRoles: string[] }
  | { action: "setFolderAccess"; folderId: string; viewRoles: string[]; uploadRoles: string[] };

export type ActionResult = DocListing & { added?: { name: string; documentId: string; versionNo: number }[]; folderId?: string };

/** Runs one documents action; the answer (the fresh listing) replaces the cached one. */
export function useDocAction(projectId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ActionBody) => call<ActionResult>({ ...body, projectId }),
    onSuccess: (listing) => queryClient.setQueryData(key(projectId), listing),
    // Someone else changed it meanwhile (STATE_CHANGED), or it is gone: show the current state.
    onError: () => void queryClient.invalidateQueries({ queryKey: key(projectId) })
  });
}

/**
 * Uploads files into a folder: asks the Function for links (one call for up to 10 files), PUTs
 * each file, and answers the uploads to attach in order; a file whose upload failed comes back as
 * an Error in its place. Documents are sent as they are (no photo shrinking: a site photo filed
 * as a document keeps its full size).
 */
export async function uploadDocs(projectId: string, folderId: string, files: File[], onProgress?: (index: number, done: number) => void) {
  const { uploads } = await call<{ uploads: UploadSlot[] }>({
    action: "uploadLinks",
    projectId,
    folderId,
    files: files.map((f) => ({ name: f.name, contentType: f.type || "application/octet-stream", sizeBytes: f.size }))
  });
  return Promise.all(
    files.map(async (file, i): Promise<NewAttachment | Error> => {
      const slot = uploads[i];
      if (!slot) return new Error("no upload link");
      try {
        await put(slot.uploadUrl, file, slot.contentType || "application/octet-stream", (d) => onProgress?.(i, d));
        const { uploadUrl: _u, thumbnailUploadUrl: _t, ...attachment } = slot;
        return attachment;
      } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
      }
    })
  );
}

/** A download link for one version (the current one when versionNo is left out); valid about an hour. */
export function docLink(projectId: string, documentId: string, versionNo?: number) {
  return call<{ url: string; fileName: string; contentType: string }>({ action: "downloadLink", projectId, documentId, versionNo });
}
