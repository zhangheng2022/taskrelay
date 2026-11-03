"""Generate the TaskRelay geometric application mark (no external artwork)."""
import struct,zlib,pathlib
root=pathlib.Path(__file__).resolve().parent.parent/'resources'
root.mkdir(exist_ok=True)
def png(size):
    rows=[]
    for y in range(size):
        row=bytearray()
        for x in range(size):
            u,v=x/size,y/size
            inside=.06<u<.94 and .06<v<.94
            stroke=any(abs(v-(level+abs(u-.5)*.48))<.027 and .22<u<.78 for level in [.26,.40,.54])
            row.extend((239,248,239,255) if stroke else (20,107,94,255) if inside else (0,0,0,0))
        rows.append(b'\0'+row)
    def chunk(t,b):return struct.pack('>I',len(b))+t+b+struct.pack('>I',zlib.crc32(t+b)&0xffffffff)
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',size,size,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(b''.join(rows)))+chunk(b'IEND',b'')
data=png(256)
(root/'icon.png').write_bytes(data)
(root/'icon.ico').write_bytes(struct.pack('<HHH',0,1,1)+struct.pack('<BBBBHHII',0,0,0,0,1,32,len(data),22)+data)
