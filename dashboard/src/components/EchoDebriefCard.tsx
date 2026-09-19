import { useState, useRef, useEffect } from 'react';

export function EchoDebriefCard({ activeMealId }: { activeMealId: number | null }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [chatLog, setChatLog] = useState<{ role: 'user' | 'echo', text: string }[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<any>(null);

  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    const loadVoices = () => {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length > 0) {
        const preferred = voices.find(v => 
          (v.lang === 'en-US' || v.lang === 'en_US') && (
            v.name.includes('Zira') || 
            v.name.includes('Samantha') || 
            v.name.includes('Google US English') ||
            v.name.includes('Victoria')
          )
        ) || voices.find(v => v.lang.includes('en-US') && v.name.includes('Female'))
          || voices.find(v => v.lang.includes('en-US'));
        
        if (preferred) setSelectedVoice(preferred);
      }
    };
    
    loadVoices();
    if ('speechSynthesis' in window) {
      window.speechSynthesis.onvoiceschanged = loadVoices;
    }
  }, []);

  const startListening = () => {
    if (!('webkitSpeechRecognition' in window)) {
      setError("Speech recognition is not supported in this browser.");
      return;
    }

    const SpeechRecognition = (window as any).webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    recognitionRef.current = recognition;
    
    recognition.continuous = false;
    recognition.interimResults = false;
    
    recognition.onstart = () => setListening(true);
    recognition.onresult = (event: any) => {
      const text = event.results[0][0].transcript;
      setChatLog(prev => [...prev, { role: 'user', text }]);
      sendMessage(text);
    };
    recognition.onerror = (event: any) => {
      console.error(event.error);
      setError(`Microphone error: ${event.error}`);
      setListening(false);
    };
    recognition.onend = () => setListening(false);
    
    recognition.start();
  };

  const sendMessage = async (message: string) => {
    if (!activeMealId) {
      setError("Start a meal first.");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/ai/echo-chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meal_id: activeMealId, message })
      });
      
      if (!res.ok) {
        throw new Error("Failed to get response");
      }
      
      const data = await res.json();
      setChatLog(prev => [...prev, { role: 'echo', text: data.reply }]);

      if ('speechSynthesis' in window) {
        const utterance = new SpeechSynthesisUtterance(data.reply);
        if (selectedVoice) utterance.voice = selectedVoice;
        
        utterance.onend = () => {
          setLoading(false);
        };
        utterance.onerror = () => {
          setLoading(false);
        };
        
        window.speechSynthesis.speak(utterance);
      } else {
        setLoading(false);
      }
    } catch (err: any) {
      setError(err.message);
      setLoading(false);
    }
  };

  const playFullDebrief = async () => {
    if (!activeMealId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/ai/echo-debrief`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meal_id: activeMealId })
      });
      const data = await res.json();
      setChatLog(prev => [...prev, { role: 'user', text: "Give me the full debrief." }, { role: 'echo', text: data.debrief }]);
      
      if ('speechSynthesis' in window) {
        const utterance = new SpeechSynthesisUtterance(data.debrief);
        if (selectedVoice) utterance.voice = selectedVoice;
        
        utterance.onend = () => {
          setLoading(false);
        };
        utterance.onerror = () => {
          setLoading(false);
        };
        
        window.speechSynthesis.speak(utterance);
      } else {
        setLoading(false);
      }
    } catch (err) {
      setLoading(false);
    }
  };

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <h3 style={{ margin: 0, color: 'var(--text-primary)' }}>Echo Voice Coach</h3>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button 
            onClick={startListening}
            className="btn"
            style={{ 
              background: listening ? 'var(--status-critical)' : 'var(--plane)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border)'
            }}
          >
            {listening ? 'Listening...' : '🎤 Ask a Question'}
          </button>
          <button 
            onClick={playFullDebrief} 
            disabled={loading || !activeMealId}
            className="btn"
          >
            {loading ? 'Thinking...' : '🔊 Full Debrief'}
          </button>
        </div>
      </div>
      
      {error && <div className="banner-warn">{error}</div>}
      
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1rem', maxHeight: '200px', overflowY: 'auto' }}>
        {chatLog.map((msg, i) => (
          <div key={i} style={{ 
            alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
            background: msg.role === 'user' ? 'var(--series-salinity)' : 'var(--plane)',
            color: msg.role === 'user' ? '#fff' : 'var(--text-primary)',
            padding: '8px 12px',
            borderRadius: '12px',
            border: msg.role === 'echo' ? '1px solid var(--border)' : 'none',
            maxWidth: '80%'
          }}>
            {msg.text}
          </div>
        ))}
      </div>
      
      {chatLog.length === 0 && !error && (
        <p className="cap">
          Ask Echo specific questions like "How much sodium have I had?" or "Am I eating too fast?"
        </p>
      )}
    </div>
  );
}
