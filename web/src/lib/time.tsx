import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

// One shared 1s ticker drives every live RelativeTime / CountdownTimer, so the UI
// feels live between the coarser data polls without N independent intervals.
const NowContext = createContext<number>(Date.now());

export function TickProvider({ children }: { children: ReactNode }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <NowContext.Provider value={now}>{children}</NowContext.Provider>;
}

export function useNow(): number {
  return useContext(NowContext);
}
