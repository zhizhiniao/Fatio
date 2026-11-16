using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

// A Fatio-owned Windows browser. Remote documents have no host objects or IPC.
sealed class ChannelsWindow : Form {
    readonly WebView2 view = new WebView2();
    readonly MenuStrip bar = new MenuStrip();
    readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 16777216 };
    readonly string profile, mode;
    readonly IntPtr owner;
    readonly HashSet<string> subscribed = new HashSet<string>();
    [DllImport("user32.dll")] static extern IntPtr SetParent(IntPtr child, IntPtr parent);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("shell32.dll", CharSet=CharSet.Unicode)] static extern int SetCurrentProcessExplicitAppUserModelID(string appId);
    CoreWebView2 browser { get { return view.CoreWebView2; } }
    bool Allowed(string raw) {
        Uri u;
        return raw=="about:blank" || (Uri.TryCreate(raw, UriKind.Absolute, out u) && u.Scheme=="https" && u.IsDefaultPort && u.UserInfo=="" &&
            (u.Host=="weixin.qq.com" || u.Host.EndsWith(".weixin.qq.com",StringComparison.OrdinalIgnoreCase)));
    }
    ChannelsWindow(string[] args) {
        profile=args[0]; mode=args[1]; owner=new IntPtr(long.Parse(args[2]));
        Text=args[3]; Width=1050; Height=800; StartPosition=FormStartPosition.CenterScreen;
        ShowInTaskbar=mode=="window"; bar.Visible=false;
        var icon=Icon.ExtractAssociatedIcon(Application.ExecutablePath);if(icon!=null)Icon=icon;
        view.Dock=DockStyle.Fill; Controls.Add(view); Controls.Add(bar);
        if(mode=="embed") FormBorderStyle=FormBorderStyle.None;
    }
    protected override CreateParams CreateParams {
        get {
            var p=base.CreateParams;
            if(mode=="embed" && owner!=IntPtr.Zero){p.Parent=owner;p.Style=(p.Style & ~unchecked((int)0x80000000)) | 0x40000000;}
            return p;
        }
    }
    void Send(object value){Console.Out.WriteLine(json.Serialize(value));Console.Out.Flush();}
    async void Start(){
        try {
            if(mode=="embed" && owner!=IntPtr.Zero)SetParent(Handle,owner);
            var env=await CoreWebView2Environment.CreateAsync(null,profile);
            await view.EnsureCoreWebView2Async(env);
            var b=browser;
            b.Settings.AreDevToolsEnabled=false;b.Settings.AreHostObjectsAllowed=false;
            b.Settings.IsWebMessageEnabled=false;b.Settings.AreBrowserAcceleratorKeysEnabled=false;
            b.Settings.IsGeneralAutofillEnabled=false;b.Settings.IsPasswordAutosaveEnabled=false;
            b.NavigationStarting+=(s,e)=>{if(!Allowed(e.Uri))e.Cancel=true;};
            b.NewWindowRequested+=(s,e)=>{e.Handled=true;if(Allowed(e.Uri))b.Navigate(e.Uri);};
            b.PermissionRequested+=(s,e)=>{e.State=CoreWebView2PermissionState.Deny;};
            b.NavigationCompleted+=(s,e)=>Send(new {evt="loaded",url=b.Source,ok=e.IsSuccess});
            b.SourceChanged+=(s,e)=>Send(new {evt="location",url=b.Source});
            Send(new {evt="ready"});
            if(mode=="window")Show();
            await Task.Run((Action)ReadCommands);
        } catch(Exception e){Send(new {evt="fatal",error=e.Message});Close();}
    }
    void ReadCommands(){
        string line;
        try{
            while((line=Console.In.ReadLine())!=null){
                var message=line;
                BeginInvoke(new Action(()=>Command(message)));
            }
        }catch(Exception){}
        if(!IsDisposed)try{BeginInvoke(new Action(Close));}catch(InvalidOperationException){}
    }
    async void Command(string message){
        int id=0;
        try{
            var m=json.Deserialize<Dictionary<string,object>>(message);
            id=Convert.ToInt32(m["id"]);var op=(string)m["op"];
            var arg=m.ContainsKey("arg")?m["arg"]:null;object result=null;
            switch(op){
                case "load":{
                    string url=(string)arg;if(!Allowed(url))throw new Exception("视频号页面地址无效");
                    var done=new TaskCompletionSource<bool>(); EventHandler<CoreWebView2NavigationCompletedEventArgs> completed=(s,e)=>{
                        if(e.IsSuccess||e.WebErrorStatus!=CoreWebView2WebErrorStatus.OperationCanceled)done.TrySetResult(e.IsSuccess);
                    };
                    browser.NavigationCompleted+=completed;
                    try{browser.Navigate(url);if(await Task.WhenAny(done.Task,Task.Delay(20000))!=done.Task||!await done.Task)throw new Exception("视频号页面未能加载");}
                    finally{browser.NavigationCompleted-=completed;}
                    break;
                }
                case "cdp":{
                    var d=(Dictionary<string,object>)arg;
                    result=json.DeserializeObject(await browser.CallDevToolsProtocolMethodAsync((string)d["method"],json.Serialize(d["params"])));
                    break;
                }
                case "subscribe":{
                    string name=(string)arg;
                    if(subscribed.Add(name))browser.GetDevToolsProtocolEventReceiver(name).DevToolsProtocolEventReceived+=(s,e)=>Send(new {evt="cdp",method=name,data=json.DeserializeObject(e.ParameterObjectAsJson)});
                    break;
                }
                case "title":Text=(string)arg;break;
                case "menu":{
                    bar.Items.Clear();
                    foreach(object entry in (System.Collections.IEnumerable)arg){
                        var spec=entry as Dictionary<string,object>;
                        var item=new ToolStripMenuItem(spec==null?(string)entry:(string)spec["label"]);
                        if(spec!=null){
                            item.Enabled=(bool)spec["enabled"];
                            item.ToolTipText=(string)spec["hint"];
                        }
                        if(spec!=null && spec.ContainsKey("children") && spec["children"]!=null){
                            foreach(string child in (System.Collections.IEnumerable)spec["children"]){
                                var option=new ToolStripMenuItem(child);
                                option.Click+=(s,e)=>Send(new {evt="action",label=option.Text});
                                item.DropDownItems.Add(option);
                            }
                        }else item.Click+=(s,e)=>Send(new {evt="action",label=item.Text});
                        bar.Items.Add(item);
                    }
                    bar.Visible=bar.Items.Count>0;break;
                }
                case "focus":Show();Activate();view.Focus();break;
                case "hide":Hide();break;
                case "bounds":{var r=(Dictionary<string,object>)arg;SetBounds(Convert.ToInt32(r["x"]),Convert.ToInt32(r["y"]),Convert.ToInt32(r["width"]),Convert.ToInt32(r["height"]));if(!Visible)Show();break;}
                case "reload":browser.Reload();break;
                case "back":if(browser.CanGoBack)browser.GoBack();break;
                case "forward":if(browser.CanGoForward)browser.GoForward();break;
                case "confirm":result=MessageBox.Show(this,(string)arg,"发条 Fatio",MessageBoxButtons.OKCancel,MessageBoxIcon.Question,MessageBoxDefaultButton.Button2)==DialogResult.OK;break;
                case "notice":MessageBox.Show(this,(string)arg,"发条 Fatio");break;
                case "clear":await browser.Profile.ClearBrowsingDataAsync();break;
                case "close":Close();return;
                default:throw new Exception("不支持的窗口操作");
            }
            Send(new {id=id,result=result});
        } catch(Exception e){if(!IsDisposed)Send(new {id=id,error=e.Message});}
    }
    [STAThread] static void Main(string[] args){
        Console.SetIn(new StreamReader(Console.OpenStandardInput(),new UTF8Encoding(false)));
        Console.SetOut(new StreamWriter(Console.OpenStandardOutput(),new UTF8Encoding(false)){AutoFlush=true});
        Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
        try{SetProcessDpiAwarenessContext(new IntPtr(-4));}catch(EntryPointNotFoundException){}
        SetCurrentProcessExplicitAppUserModelID("Fatio.CreatorWorkspace");
        using(var form=new ChannelsWindow(args)){
            form.FormClosed+=(s,e)=>Application.ExitThread();
            var handle=form.Handle;
            form.BeginInvoke(new Action(form.Start));Application.Run();
        }
    }
}
