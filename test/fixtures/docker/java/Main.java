import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;

public class Main {
    public static void main(String[] argv) throws IOException, InterruptedException {
        String targetUrl = argv[0];
        URL url = new URL(targetUrl);

        System.out.println("Starting Java container");
        while (true) {
            HttpURLConnection con = (HttpURLConnection) url.openConnection();
            con.setRequestMethod("GET");
            int status = con.getResponseCode();
            System.out.println("Got " + status + " response");

            Thread.sleep(500);
        }
    }
}