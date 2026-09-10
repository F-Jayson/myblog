import { useEffect, useRef } from "react";
import { createApp, h, reactive } from "vue";
import { MdEditor } from "md-editor-v3";
import "md-editor-v3/lib/style.css";

type MdEditorBridgeProps = {
  value: string;
  onChange: (value: string) => void;
  onUploadImage?: (file: File) => Promise<string>;
  onUploadError?: (error: unknown) => void;
  preview?: boolean;
};

// md-editor-v3 is implemented for Vue. This keeps its lifecycle contained while
// exposing a small controlled React surface to the article editor.
export default function MdEditorBridge({
  value,
  onChange,
  onUploadImage,
  onUploadError,
  preview = true,
}: MdEditorBridgeProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<{ modelValue: string } | null>(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const onUploadImageRef = useRef(onUploadImage);
  const onUploadErrorRef = useRef(onUploadError);
  valueRef.current = value;
  onChangeRef.current = onChange;
  onUploadImageRef.current = onUploadImage;
  onUploadErrorRef.current = onUploadError;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const state = reactive({ modelValue: valueRef.current });
    stateRef.current = state;
    const app = createApp({
      render: () => h(MdEditor, {
        modelValue: state.modelValue,
        "onUpdate:modelValue": (next: string) => { state.modelValue = next; onChangeRef.current(next); },
        onUploadImg: onUploadImageRef.current
          ? async (files: File[], callback: (urls: string[]) => void) => {
              try {
                callback(await Promise.all(files.map((file) => onUploadImageRef.current!(file))));
              } catch (error) {
                onUploadErrorRef.current?.(error);
              }
            }
          : undefined,
        language: "zh-CN",
        previewTheme: "github",
        preview,
      }),
    });
    app.mount(host);
    return () => { stateRef.current = null; app.unmount(); };
  }, []);

  useEffect(() => {
    if (stateRef.current) stateRef.current.modelValue = value;
  }, [value]);

  return <div className="fa-md-editor-bridge" ref={hostRef} />;
}
