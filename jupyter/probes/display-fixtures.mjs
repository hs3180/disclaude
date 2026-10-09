/** Kernel-side MIME fixtures use only Python's standard library and IPython display. */
const pngChart = String.raw`import struct,zlib
def probe_png(values,bars=False):
    width,height=480,300
    pixels=bytearray([255])*(width*height*3)
    ink=(40,40,40)
    blue=(40,100,210)
    def dot(x,y,color=ink,radius=0):
        for row in range(max(0,y-radius),min(height,y+radius+1)):
            for column in range(max(0,x-radius),min(width,x+radius+1)):
                start=(row*width+column)*3
                pixels[start:start+3]=bytes(color)
    def line(a,b,color=ink):
        steps=max(abs(b[0]-a[0]),abs(b[1]-a[1]),1)
        for index in range(steps+1):
            dot(round(a[0]+(b[0]-a[0])*index/steps),round(a[1]+(b[1]-a[1])*index/steps),color,1)
    # Tiny visible labels keep this protocol fixture independent of font/rendering packages.
    font={
        '0':'111101101101111','1':'010110010010111','2':'110001010100111',
        '3':'110001010001110','4':'101101111001001','5':'111100110001110',
        '6':'011100111101111','7':'111001010010010','8':'111101111101111',
        '9':'111101111001110','.':'000000000000010','A':'010101111101101',
        'B':'110101110101110','C':'011100100100011','E':'111100110100111',
        'L':'100100100100111','P':'110101110100100','S':'011100010001110',
        'T':'111010010010010','U':'101101101101111','V':'101101101101010',
    }
    def label(text,x,y):
        for character in text:
            for index,bit in enumerate(font.get(character,'0'*15)):
                if bit=='1':
                    dot(x+(index%3)*3+1,y+(index//3)*3+1,ink,1)
            x+=12
    maximum=max(values)
    label('VALUE',5,10)
    label(format(maximum,'g'),5,42)
    label('0',40,239)
    label('STEP' if not bars else 'ABC',215,278)
    line((65,35),(65,245))
    line((65,245),(440,245))
    points=[]
    for index,value in enumerate(values):
        x=round(85+315*index/(len(values)-1)) if not bars else round(137+105*index)
        y=round(245-195*value/maximum)
        label(str(index+1) if not bars else chr(65+index),x-4,254)
        if bars:
            for column in range(x-25,x+26):
                for row in range(y,245):
                    dot(column,row,blue)
        else:
            if points:
                line(points[-1],(x,y),blue)
            dot(x,y,blue,5)
        points.append((x,y))
    raw=b''.join(b'\0'+bytes(pixels[row*width*3:(row+1)*width*3]) for row in range(height))
    def chunk(kind,data):
        return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>2I5B',width,height,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b'')
`;

export const lineChartSource = `${pngChart}
from IPython.display import display,Image
display(Image(data=probe_png([mvp_value,mvp_value*2,mvp_value*3]),format='png'))
`;

// Small inline interaction tests report transport without loading a plotting library or CDN.
export const reportInteraction = `const root = document.currentScript.parentElement;
root.querySelector('button').onclick = () => {
  const values = JSON.parse(root.dataset.reportValues);
  root.querySelector('[data-summary]').textContent = 'Sum: ' + values.reduce((sum, value) => sum + value, 0);
};`;

export function reportStudySource(csvPath) {
  return `${pngChart}
import csv,html,json,random,statistics,sys
from IPython.display import display,Image,SVG,HTML
with open(${JSON.stringify(csvPath)},newline='') as stream:
    rows=list(csv.DictReader(stream))
values=[float(row['value']) for row in rows]
rng=random.Random(63)
summary={'mean':statistics.mean(values),'sample_std':statistics.stdev(values),'seeded_mean':statistics.mean(rng.gauss(0,1) for _ in range(1000)),'seed':63,'runtime':{'python':sys.version.split()[0]}}
print('STUDY_RESULT '+json.dumps(summary,sort_keys=True),flush=True)
display(Image(data=probe_png(values,bars=True),format='png'))
bars=''.join('<rect x="'+str(30+index*70)+'" y="'+str(170-value*20)+'" width="40" height="'+str(value*20)+'" fill="royalblue"/><text x="'+str(30+index*70)+'" y="190">'+html.escape(row['group'])+'</text>' for index,(row,value) in enumerate(zip(rows,values)))
display(SVG('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="220">'+bars+'<text x="5" y="215">SVG_REPORT_MARKER</text></svg>'))
display(HTML('<table><tr><th>Mean</th><td>'+str(summary['mean'])+'</td></tr></table>'))
interaction=${JSON.stringify(reportInteraction)}
display(HTML('<div data-report-values="'+html.escape(json.dumps(values),quote=True)+'"><h3>HTML_REPORT_MARKER</h3><button type="button">Show sum</button><span data-summary>Mean: '+str(summary['mean'])+'</span><script>'+interaction+'</script></div>'))
`;
}
