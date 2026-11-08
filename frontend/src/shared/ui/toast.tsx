import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';

type Notify = (message: string, error?: boolean) => void;
const ToastContext = createContext<Notify>(() => {});

export function ToastProvider({ children, duration = 6000, withIcon = true }: { children: ReactNode; duration?: number; withIcon?: boolean }) {
  const [toast, setToast] = useState<{ message: string; error: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const notify = useCallback<Notify>((message, error = false) => {
    clearTimeout(timer.current);
    setToast({ message, error });
    timer.current = setTimeout(() => setToast(null), duration);
  }, [duration]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const target = document.getElementById('toast-root');
  return (
    <ToastContext.Provider value={notify}>
      {children}
      {target && toast && createPortal(
        <div className={`toast ${toast.error ? 'error' : ''}`}>
          {withIcon ? <><Icon name={toast.error ? 'search' : 'check'} /><span>{toast.message}</span></> : toast.message}
        </div>,
        target,
      )}
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
