// Read committed segments of a disposable benchmark index. No writer or mutation.
import java.nio.file.*;
import java.util.*;
import org.apache.lucene.store.*;
import org.apache.lucene.index.*;
public class StorageIndexFiles {
 public static void main(String[] args) throws Exception {
  try(Directory dir=FSDirectory.open(Path.of(args[0]))) {
   Map<String,Long> sizes=new TreeMap<>();
   for(SegmentCommitInfo segment:SegmentInfos.readLatestCommit(dir)) {
    if(segment.info.getUseCompoundFile()) {
     try(Directory compound=segment.info.getCodec().compoundFormat().getCompoundReader(dir,segment.info,IOContext.READONCE)) {
      for(String name:compound.listAll()) sizes.merge(name.substring(name.lastIndexOf('.')+1),compound.fileLength(name),Long::sum);
     }
     for(String name:segment.files())if(!name.endsWith(".cfs"))sizes.merge(name.substring(name.lastIndexOf('.')+1),dir.fileLength(name),Long::sum);
    } else for(String name:segment.files())sizes.merge(name.substring(name.lastIndexOf('.')+1),dir.fileLength(name),Long::sum);
   }
   long source=0,recovery=0;
   try(DirectoryReader reader=DirectoryReader.open(dir)) {
    StoredFields fields=reader.storedFields();
    for(int i=0;i<reader.maxDoc();i++) {
     var document=fields.document(i,Set.of("_source","_recovery_source"));
     var s=document.getBinaryValue("_source");if(s!=null)source+=s.length;
     var r=document.getBinaryValue("_recovery_source");if(r!=null)recovery+=r.length;
    }
   }
   System.out.println("{\"source_raw_bytes\":"+source+",\"recovery_source_raw_bytes\":"+recovery+",\"files\":{");
   StringJoiner entries=new StringJoiner(",");for(var e:sizes.entrySet())entries.add("\""+e.getKey()+"\":"+e.getValue());
   System.out.println(entries+"}}");
  }
 }
}
